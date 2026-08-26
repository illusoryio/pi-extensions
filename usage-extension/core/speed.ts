import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import {
	getAgentDir,
	getDefaultCachePath,
	loadUsageCache,
	TAB_ORDER,
} from "./data.ts";
import type { CachedFileState, PeriodBounds, TabName, UsageData } from "./data.ts";
import {
	getDefaultClassificationCachePath,
	TASK_TYPES,
} from "./tasks.ts";
import type { TaskType } from "./tasks.ts";

export interface SpeedSummary {
	turns: number;
	medianTokPerSec: number;
	p25TokPerSec: number;
	p75TokPerSec: number;
	medianLatencyMs: number;
}

export interface SpeedCell {
	taskType: TaskType;
	provider: string;
	model: string;
	sessions: Set<string>;
	rates: number[];
	latenciesMs: number[];
}

export interface SpeedPeriodStats {
	cells: Map<string, SpeedCell>;
	totals: SpeedSummary & { sessions: number };
}

export type SpeedUsageData = Record<TabName, SpeedPeriodStats>;

export interface SpeedRow extends SpeedSummary {
	taskType: TaskType;
	provider: string;
	model: string;
	sessions: number;
}

export interface SpeedExclusions {
	nonPositiveLatency: number;
	overTenMinutes: number;
	zeroOutputTokens: number;
}

export interface SpeedCollection {
	data: SpeedUsageData;
	exclusions: SpeedExclusions;
}

interface TurnTiming {
	key: string;
	provider: string;
	model: string;
	usageTimestamp: number;
	latencyMs: number;
	tokensPerSecond: number;
}

type SpeedExclusionReason = keyof SpeedExclusions;

interface SpeedExclusionRecord {
	key: string;
	reason: SpeedExclusionReason;
}

interface ScannedSpeedFile {
	sessionId: string;
	turns: TurnTiming[];
	exclusions: SpeedExclusionRecord[];
}

interface SpeedCacheEntry {
	size: number;
	mtimeMs: number;
	scan: ScannedSpeedFile;
}

interface SpeedCacheFile {
	version: 1;
	files: Record<string, SpeedCacheEntry>;
}

interface CachedTaskClassification {
	taskType?: unknown;
}

export interface CollectSpeedOptions {
	usageData: UsageData;
	usageCachePath?: string;
	classificationCachePath?: string;
	speedCachePath?: string;
	signal?: AbortSignal;
}

const CACHE_VERSION = 1;
const CACHE_CONCURRENCY = 8;
export const MAX_TURN_LATENCY_MS = 10 * 60_000;
const CELL_SEP = "\u0000";
const EXCLUDED_PROVIDERS = new Set(["faux-provider", "fake-provider"]);

export function getDefaultSpeedCachePath(): string {
	return join(getAgentDir(), "pi-usage-cache", "speed.json");
}

function emptyExclusions(): SpeedExclusions {
	return { nonPositiveLatency: 0, overTenMinutes: 0, zeroOutputTokens: 0 };
}

function emptySummary(): SpeedSummary {
	return { turns: 0, medianTokPerSec: 0, p25TokPerSec: 0, p75TokPerSec: 0, medianLatencyMs: 0 };
}

function emptyPeriod(): SpeedPeriodStats {
	return { cells: new Map(), totals: { ...emptySummary(), sessions: 0 } };
}

function emptyData(): SpeedUsageData {
	return {
		today: emptyPeriod(),
		thisWeek: emptyPeriod(),
		lastWeek: emptyPeriod(),
		last30Days: emptyPeriod(),
		allTime: emptyPeriod(),
	};
}

function isTaskType(value: unknown): value is TaskType {
	return typeof value === "string" && TASK_TYPES.includes(value as TaskType);
}

function cellKey(taskType: TaskType, provider: string, model: string): string {
	return taskType + CELL_SEP + provider + CELL_SEP + model;
}

function parsedTimestamp(messageTimestamp: unknown, entryTimestamp: unknown): number {
	const parsed = typeof messageTimestamp === "number"
		? messageTimestamp
		: new Date(String(messageTimestamp ?? entryTimestamp ?? "")).getTime();
	return Number.isFinite(parsed) ? parsed : 0;
}

function entryTimestamp(timestamp: unknown): number {
	const parsed = typeof timestamp === "number" ? timestamp : new Date(String(timestamp ?? "")).getTime();
	return Number.isFinite(parsed) ? parsed : 0;
}

function usageNumber(usage: unknown, field: string): number {
	if (!usage || typeof usage !== "object") return 0;
	const value = Number((usage as Record<string, unknown>)[field] ?? 0);
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageFingerprint(usage: unknown): number {
	return usageNumber(usage, "input") + usageNumber(usage, "output") +
		usageNumber(usage, "cacheRead") + usageNumber(usage, "cacheWrite");
}

export function percentile(values: number[], quantile: number): number {
	if (values.length === 0) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower]!;
	const weight = position - lower;
	return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function summarizeSpeed(rates: number[], latenciesMs: number[]): SpeedSummary {
	return {
		turns: Math.min(rates.length, latenciesMs.length),
		medianTokPerSec: percentile(rates, 0.5),
		p25TokPerSec: percentile(rates, 0.25),
		p75TokPerSec: percentile(rates, 0.75),
		medianLatencyMs: percentile(latenciesMs, 0.5),
	};
}

async function scanFile(filePath: string, signal?: AbortSignal): Promise<ScannedSpeedFile> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let sessionId = "";
	let boundaryTimestamp: number | null = null;
	const turns: TurnTiming[] = [];
	const exclusions: SpeedExclusionRecord[] = [];
	try {
		for await (const line of lines) {
			if (signal?.aborted) break;
			const head = line.slice(0, 2_048);
			if (!head.includes('"type":"session"') && !head.includes('"type": "session"') &&
				!head.includes('"role":"assistant"') && !head.includes('"role": "assistant"') &&
				!head.includes('"role":"user"') && !head.includes('"role": "user"') &&
				!head.includes('"role":"toolResult"') && !head.includes('"role": "toolResult"')) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.type === "session") {
					sessionId = typeof entry.id === "string" ? entry.id : "";
					continue;
				}
				if (entry?.type !== "message") continue;
				const message = entry.message;
				if (message?.role === "user" || message?.role === "toolResult") {
					const timestamp = entryTimestamp(entry.timestamp);
					boundaryTimestamp = timestamp > 0 ? timestamp : null;
					continue;
				}
				if (message?.role !== "assistant") continue;
				const startedAt = boundaryTimestamp;
				boundaryTimestamp = null;
				if (startedAt === null || !message.provider || !message.model || !message.usage) continue;
				if (EXCLUDED_PROVIDERS.has(message.provider)) continue;
				const completedAt = entryTimestamp(entry.timestamp);
				const latencyMs = completedAt - startedAt;
				const outputTokens = usageNumber(message.usage, "output");
				const usageTimestamp = parsedTimestamp(message.timestamp, entry.timestamp);
				const fingerprint = usageFingerprint(message.usage);
				const key = `assistant:${usageTimestamp}:${fingerprint}`;
				if (latencyMs <= 0) {
					exclusions.push({ key, reason: "nonPositiveLatency" });
					continue;
				}
				if (latencyMs > MAX_TURN_LATENCY_MS) {
					exclusions.push({ key, reason: "overTenMinutes" });
					continue;
				}
				if (outputTokens <= 0) {
					exclusions.push({ key, reason: "zeroOutputTokens" });
					continue;
				}
				turns.push({
					key,
					provider: message.provider,
					model: message.model,
					usageTimestamp,
					latencyMs,
					tokensPerSecond: outputTokens / (latencyMs / 1_000),
				});
			} catch {
				// Ignore malformed or truncated history lines.
			}
		}
	} catch {
		// A disappearing/unreadable file is treated as an empty scan this round.
	} finally {
		lines.close();
		stream.destroy();
	}
	return { sessionId, turns, exclusions };
}

async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(values.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
		while (next < values.length) {
			const index = next++;
			results[index] = await fn(values[index]!);
		}
	}));
	return results;
}

async function loadCache(path: string): Promise<Map<string, SpeedCacheEntry>> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SpeedCacheFile>;
		if (parsed.version !== CACHE_VERSION || !parsed.files || typeof parsed.files !== "object") return new Map();
		return new Map(Object.entries(parsed.files).filter((entry): entry is [string, SpeedCacheEntry] => {
			const value = entry[1];
			return !!value && typeof value.size === "number" && typeof value.mtimeMs === "number" &&
				!!value.scan && typeof value.scan.sessionId === "string" && Array.isArray(value.scan.turns) &&
				Array.isArray(value.scan.exclusions);
		}));
	} catch {
		return new Map();
	}
}

async function saveCache(path: string, entries: Map<string, SpeedCacheEntry>): Promise<void> {
	const files: Record<string, SpeedCacheEntry> = {};
	for (const [filePath, entry] of entries) files[filePath] = entry;
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, files } satisfies SpeedCacheFile));
	await rename(temporary, path);
}

async function currentScans(
	states: Map<string, CachedFileState>,
	cachePath: string,
	signal?: AbortSignal
): Promise<Map<string, ScannedSpeedFile>> {
	const previous = await loadCache(cachePath);
	const current = new Map<string, SpeedCacheEntry>();
	const changed: Array<[string, CachedFileState]> = [];
	for (const [filePath, state] of states) {
		const cached = previous.get(filePath);
		if (cached && cached.size === state.size && cached.mtimeMs === state.mtimeMs) current.set(filePath, cached);
		else changed.push([filePath, state]);
	}
	const scans = await mapLimit(changed, CACHE_CONCURRENCY, async ([filePath, state]) => ({
		filePath,
		entry: { size: state.size, mtimeMs: state.mtimeMs, scan: await scanFile(filePath, signal) },
	}));
	if (!signal?.aborted) {
		for (const { filePath, entry } of scans) current.set(filePath, entry);
		await saveCache(cachePath, current).catch(() => {});
	}
	return new Map(Array.from(current, ([filePath, entry]) => [filePath, entry.scan]));
}

async function loadTaskTypes(path: string): Promise<Map<string, TaskType>> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		const result = new Map<string, TaskType>();
		for (const [sessionId, value] of Object.entries(parsed?.sessions ?? {}) as Array<[string, CachedTaskClassification]>) {
			if (isTaskType(value.taskType)) result.set(sessionId, value.taskType);
		}
		return result;
	} catch {
		return new Map();
	}
}

function periodsFor(timestamp: number, bounds: PeriodBounds): TabName[] {
	const periods: TabName[] = ["allTime"];
	if (timestamp >= bounds.last30DaysStartMs && timestamp <= bounds.nowMs) periods.push("last30Days");
	if (timestamp >= bounds.lastWeekStartMs && timestamp < bounds.weekStartMs) periods.push("lastWeek");
	if (timestamp >= bounds.weekStartMs && timestamp <= bounds.nowMs) periods.push("thisWeek");
	if (timestamp >= bounds.todayMs && timestamp <= bounds.nowMs) periods.push("today");
	return periods;
}

function getCell(period: SpeedPeriodStats, taskType: TaskType, provider: string, model: string): SpeedCell {
	const key = cellKey(taskType, provider, model);
	let cell = period.cells.get(key);
	if (!cell) {
		cell = { taskType, provider, model, sessions: new Set(), rates: [], latenciesMs: [] };
		period.cells.set(key, cell);
	}
	return cell;
}

function aggregate(
	scans: Map<string, ScannedSpeedFile>,
	taskTypes: Map<string, TaskType>,
	bounds: PeriodBounds
): SpeedCollection {
	const data = emptyData();
	const exclusions = emptyExclusions();
	const seen = new Set<string>();
	const seenExclusions = new Set<string>();
	const periodSessions = Object.fromEntries(TAB_ORDER.map((period) => [period, new Set<string>()])) as Record<TabName, Set<string>>;
	const periodRates = Object.fromEntries(TAB_ORDER.map((period) => [period, []])) as Record<TabName, number[]>;
	const periodLatencies = Object.fromEntries(TAB_ORDER.map((period) => [period, []])) as Record<TabName, number[]>;

	for (const [, scan] of Array.from(scans.entries()).sort(([a], [b]) => a.localeCompare(b))) {
		const sessionId = scan.sessionId;
		const taskType = taskTypes.get(sessionId) ?? "other";
		for (const exclusion of scan.exclusions) {
			if (seenExclusions.has(exclusion.key)) continue;
			seenExclusions.add(exclusion.key);
			exclusions[exclusion.reason]++;
		}
		for (const turn of scan.turns) {
			if (seen.has(turn.key)) continue;
			seen.add(turn.key);
			for (const periodName of periodsFor(turn.usageTimestamp, bounds)) {
				const period = data[periodName];
				const cell = getCell(period, taskType, turn.provider, turn.model);
				cell.rates.push(turn.tokensPerSecond);
				cell.latenciesMs.push(turn.latencyMs);
				cell.sessions.add(sessionId);
				periodRates[periodName].push(turn.tokensPerSecond);
				periodLatencies[periodName].push(turn.latencyMs);
				periodSessions[periodName].add(sessionId);
			}
		}
	}
	for (const periodName of TAB_ORDER) {
		data[periodName].totals = {
			...summarizeSpeed(periodRates[periodName], periodLatencies[periodName]),
			sessions: periodSessions[periodName].size,
		};
	}
	return { data, exclusions };
}

export async function collectSpeedUsageData(options: CollectSpeedOptions): Promise<SpeedCollection> {
	const states = await loadUsageCache(options.usageCachePath ?? getDefaultCachePath());
	const [scans, taskTypes] = await Promise.all([
		currentScans(states, options.speedCachePath ?? getDefaultSpeedCachePath(), options.signal),
		loadTaskTypes(options.classificationCachePath ?? getDefaultClassificationCachePath()),
	]);
	return aggregate(scans, taskTypes, options.usageData.bounds);
}

export function speedRows(stats: SpeedPeriodStats): SpeedRow[] {
	return Array.from(stats.cells.values())
		.sort((a, b) => TASK_TYPES.indexOf(a.taskType) - TASK_TYPES.indexOf(b.taskType) || b.rates.length - a.rates.length)
		.map((cell) => ({
			taskType: cell.taskType,
			provider: cell.provider,
			model: cell.model,
			sessions: cell.sessions.size,
			...summarizeSpeed(cell.rates, cell.latenciesMs),
		}));
}

function csvCell(value: string | number | boolean): string {
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildSpeedCsv(stats: SpeedPeriodStats): string {
	const lines = ["taskType,provider,model,sessions,turns,medianTokPerSec,p25TokPerSec,p75TokPerSec,medianLatencyMs,measurement,ttftAvailable"];
	for (const row of speedRows(stats)) {
		lines.push([
			row.taskType, row.provider, row.model, row.sessions, row.turns,
			row.medianTokPerSec, row.p25TokPerSec, row.p75TokPerSec, row.medianLatencyMs,
			"end-to-end turn throughput", false,
		].map(csvCell).join(","));
	}
	return lines.join("\n") + "\n";
}
