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

export interface CorrectionCounts {
	assistantTurns: number;
	corrections: number;
	rapidFollowUps: number;
}

export interface CorrectionCell extends CorrectionCounts {
	taskType: TaskType;
	provider: string;
	model: string;
	sessions: Set<string>;
}

export interface CorrectionPeriodStats {
	cells: Map<string, CorrectionCell>;
	totals: CorrectionCounts & { sessions: number };
}

export type CorrectionUsageData = Record<TabName, CorrectionPeriodStats>;

export interface CorrectionRow {
	taskType: TaskType;
	provider: string;
	model: string;
	sessions: number;
	assistantTurns: number;
	corrections: number;
	correctionRate: number;
	rapidFollowUps: number;
	rapidFollowUpRate: number;
}

export interface CorrectionMatch {
	sessionId: string;
	taskType: TaskType;
	provider: string;
	model: string;
	assistantTimestamp: number;
	userTimestamp: number;
	pattern: string;
	text: string;
}

interface AssistantTurn {
	key: string;
	provider: string;
	model: string;
	timestamp: number;
	completedAt: number;
}

interface DirectFollowUp {
	key: string;
	assistantKey: string;
	provider: string;
	model: string;
	assistantTimestamp: number;
	assistantCompletedAt: number;
	userTimestamp: number;
	text: string;
}

interface ScannedCorrectionFile {
	sessionId: string;
	turns: AssistantTurn[];
	followUps: DirectFollowUp[];
}

interface CorrectionCacheEntry {
	size: number;
	mtimeMs: number;
	scan: ScannedCorrectionFile;
}

interface CorrectionCacheFile {
	version: 1;
	files: Record<string, CorrectionCacheEntry>;
}

interface CachedTaskClassification {
	taskType?: unknown;
}

export interface CollectCorrectionOptions {
	usageData: UsageData;
	usageCachePath?: string;
	classificationCachePath?: string;
	correctionCachePath?: string;
	signal?: AbortSignal;
}

export interface CorrectionCollection {
	data: CorrectionUsageData;
	matches: CorrectionMatch[];
}

const CACHE_VERSION = 1;
const CACHE_CONCURRENCY = 8;
const RAPID_FOLLOW_UP_MS = 30_000;
const RAPID_FOLLOW_UP_MAX_CHARS = 240;
const RAPID_FOLLOW_UP_MAX_WORDS = 40;
const CELL_SEP = "\u0000";
const EXCLUDED_PROVIDERS = new Set(["faux-provider", "fake-provider"]);

const CORRECTION_PATTERNS: Array<[name: string, pattern: RegExp]> = [
	["stop", /^\s*stop\b/i],
	["no", /^\s*no(?:pe|[,.!?:;])/i],
	["fix-it", /^\s*fix\s+(?:it|this|that)\b/i],
	["try-again", /\btry again\b/i],
	["still-broken", /\bstill\s+(?:not working|doesn['’]?t work|broken|failing)\b/i],
	["wrong", /(?:^\s*(?:still\s+)?wrong\b|\b(?:you(?:'re| are| did| spawned| sent| send| used)?|your|this|that|it|something|calculations?|generation|implementation|choice|result|server|modal|widget|orchguard)\b.{0,60}\bwrong\b|\bwrong (?:thing|choice|one|model|link|iphone|port|column|agent)\b)/i],
	["why-did-you", /^\s*(?:\d+[.)]\s*)?why did you\b/i],
	["not-what", /\bnot what (?:i|we)\b/i],
	["redo", /^\s*(?:please\s+)?redo\b|\bredo (?:it|this|that)\b/i],
	["revert", /^\s*revert\b|\b(?:please|let['’]?s|can we|could we|go ahead and)\s+revert\b/i],
	["undo", /^\s*undo\b|\b(?:please|can we|could we|let['’]?s|we should)\b.{0,20}\bundo\b/i],
	["thats-not", /^\s*(?:that|this|it)['’]?s not\b/i],
	["you-damaged", /\byou (?:broke(?! down\b)|removed|deleted|missed)\b/i],
	["dont", /^\s*don['’]?t\s+(?:do|change|remove|delete|touch|use|add|make|rewrite|modify|assume|ignore)\b/i],
];

export function getDefaultCorrectionCachePath(): string {
	return join(getAgentDir(), "pi-usage-cache", "corrections.json");
}

function emptyCounts(): CorrectionCounts {
	return { assistantTurns: 0, corrections: 0, rapidFollowUps: 0 };
}

function emptyPeriod(): CorrectionPeriodStats {
	return { cells: new Map(), totals: { ...emptyCounts(), sessions: 0 } };
}

function emptyData(): CorrectionUsageData {
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

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
			? String((part as Record<string, unknown>).text ?? "")
			: "")
		.filter(Boolean)
		.join("\n")
		.replace(/^\[Pi-generated message timing[^\]]*\]\s*/i, "")
		.trim();
}

function usageFingerprint(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const value = usage as Record<string, unknown>;
	return Number(value.input ?? 0) + Number(value.output ?? 0) + Number(value.cacheRead ?? 0) + Number(value.cacheWrite ?? 0);
}

export function isShortFollowUp(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 0 &&
		trimmed.length <= RAPID_FOLLOW_UP_MAX_CHARS &&
		trimmed.split(/\s+/).length <= RAPID_FOLLOW_UP_MAX_WORDS;
}

export function correctionPattern(text: string): string | null {
	// Long pasted logs/code often quote a trigger word without correcting the model.
	// Restrict detection to the operator's concise rework instruction at the front.
	const leading = text.slice(0, 1_000);
	// Explicit acceptances and operator self-corrections are not model rework.
	if (/^\s*no(?:pe)?[,.!?:;]?\s+(?:(?:that|this|it)(?:['’]?s| is)|we(?:'re| are))\s+(?:fine|good|okay|ok)\b/i.test(leading)) return null;
	if (/^\s*(?:sorry|oops)\b.{0,100}\b(?:wrong (?:chat|session|page|thread)|sent (?:this|that|it) to the wrong)\b/i.test(leading)) return null;
	if (/^\s*correction to\b.{0,300}\bi (?:said|thought|assumed|claimed|wrote)\b.{0,300}\bwrong\b/i.test(leading)) return null;
	for (const [name, pattern] of CORRECTION_PATTERNS) {
		if (name === "wrong" && (/(?:\bcorrect me if (?:i(?:'m| am) )?wrong\b|\bi was wrong\b|\bmy fault.{0,40}wrong\b|\bwhat is wrong with\b|\bwrong agent\b|\bwrong play\b)/i.test(leading) || /\b(?:is|was) .{0,40}wrong\?\s*$/i.test(leading) || /^\s*(?:i asked .{0,120}\bsaid\b|here is the reflection\b)[\s\S]*\bwrong\b/i.test(leading))) continue;
		if (pattern.test(leading)) return name;
	}
	return null;
}

async function scanFile(filePath: string, signal?: AbortSignal): Promise<ScannedCorrectionFile> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let sessionId = "";
	let lastAssistant: AssistantTurn | null = null;
	const turns: AssistantTurn[] = [];
	const followUps: DirectFollowUp[] = [];
	try {
		for await (const line of lines) {
			if (signal?.aborted) break;
			const head = line.slice(0, 2_048);
			if (!head.includes('"type":"session"') && !head.includes('"type": "session"') &&
				!head.includes('"role":"assistant"') && !head.includes('"role": "assistant"') &&
				!head.includes('"role":"user"') && !head.includes('"role": "user"')) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.type === "session") {
					sessionId = typeof entry.id === "string" ? entry.id : "";
					continue;
				}
				if (entry?.type !== "message") continue;
				const message = entry.message;
				if (message?.role === "assistant") {
					if (!message.provider || !message.model || !message.usage) {
						lastAssistant = null;
						continue;
					}
					const timestamp = parsedTimestamp(message.timestamp, entry.timestamp);
					const completedAt = parsedTimestamp(entry.timestamp, message.timestamp);
					const fingerprint = usageFingerprint(message.usage);
					lastAssistant = {
						// Match the upstream usage parser's cross-branch dedupe identity exactly.
						key: `assistant:${timestamp}:${fingerprint}`,
						provider: message.provider,
						model: message.model,
						timestamp,
						completedAt,
					};
					turns.push(lastAssistant);
				} else if (message?.role === "user") {
					if (lastAssistant) {
						const userTimestamp = parsedTimestamp(message.timestamp, entry.timestamp);
						const text = contentText(message.content);
						const fallback = `${userTimestamp}:${lastAssistant.key}:${text.slice(0, 100)}`;
						followUps.push({
							key: typeof entry.id === "string" && entry.id ? `id:${entry.id}` : `user:${fallback}`,
							assistantKey: lastAssistant.key,
							provider: lastAssistant.provider,
							model: lastAssistant.model,
							assistantTimestamp: lastAssistant.timestamp,
							assistantCompletedAt: lastAssistant.completedAt,
							userTimestamp,
							text,
						});
					}
					lastAssistant = null;
				}
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
	return { sessionId, turns, followUps };
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

async function loadCache(path: string): Promise<Map<string, CorrectionCacheEntry>> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CorrectionCacheFile>;
		if (parsed.version !== CACHE_VERSION || !parsed.files || typeof parsed.files !== "object") return new Map();
		return new Map(Object.entries(parsed.files).filter((entry): entry is [string, CorrectionCacheEntry] => {
			const value = entry[1];
			return !!value && typeof value.size === "number" && typeof value.mtimeMs === "number" &&
				!!value.scan && typeof value.scan.sessionId === "string" && Array.isArray(value.scan.turns) && Array.isArray(value.scan.followUps);
		}));
	} catch {
		return new Map();
	}
}

async function saveCache(path: string, entries: Map<string, CorrectionCacheEntry>): Promise<void> {
	const files: Record<string, CorrectionCacheEntry> = {};
	for (const [filePath, entry] of entries) files[filePath] = entry;
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, files } satisfies CorrectionCacheFile));
	await rename(temporary, path);
}

async function currentScans(
	states: Map<string, CachedFileState>,
	cachePath: string,
	signal?: AbortSignal
): Promise<Map<string, ScannedCorrectionFile>> {
	const previous = await loadCache(cachePath);
	const current = new Map<string, CorrectionCacheEntry>();
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

function getCell(period: CorrectionPeriodStats, taskType: TaskType, provider: string, model: string): CorrectionCell {
	const key = cellKey(taskType, provider, model);
	let cell = period.cells.get(key);
	if (!cell) {
		cell = { taskType, provider, model, sessions: new Set(), ...emptyCounts() };
		period.cells.set(key, cell);
	}
	return cell;
}

interface TurnOwner {
	sessionId: string;
	taskType: TaskType;
	provider: string;
	model: string;
	timestamp: number;
}

function aggregate(
	scans: Map<string, ScannedCorrectionFile>,
	taskTypes: Map<string, TaskType>,
	bounds: PeriodBounds
): CorrectionCollection {
	const data = emptyData();
	const matches: CorrectionMatch[] = [];
	const seenTurns = new Set<string>();
	const seenFollowUps = new Set<string>();
	const owners = new Map<string, TurnOwner>();
	const periodSessions = Object.fromEntries(TAB_ORDER.map((period) => [period, new Set<string>()])) as Record<TabName, Set<string>>;

	for (const [filePath, scan] of Array.from(scans.entries()).sort(([a], [b]) => a.localeCompare(b))) {
		const sessionId = scan.sessionId;
		const taskType = taskTypes.get(sessionId) ?? "other";
		for (const turn of scan.turns) {
			if (EXCLUDED_PROVIDERS.has(turn.provider) || seenTurns.has(turn.key)) continue;
			seenTurns.add(turn.key);
			owners.set(turn.key, { sessionId, taskType, provider: turn.provider, model: turn.model, timestamp: turn.timestamp });
			for (const periodName of periodsFor(turn.timestamp, bounds)) {
				const period = data[periodName];
				const cell = getCell(period, taskType, turn.provider, turn.model);
				cell.assistantTurns++;
				cell.sessions.add(sessionId);
				period.totals.assistantTurns++;
				periodSessions[periodName].add(sessionId);
			}
		}

		for (const followUp of scan.followUps) {
			if (seenFollowUps.has(followUp.key)) continue;
			seenFollowUps.add(followUp.key);
			const owner = owners.get(followUp.assistantKey);
			if (!owner || EXCLUDED_PROVIDERS.has(owner.provider)) continue;
			const pattern = correctionPattern(followUp.text);
			const elapsed = followUp.userTimestamp - followUp.assistantCompletedAt;
			const rapid = !pattern && isShortFollowUp(followUp.text) && elapsed >= 0 && elapsed < RAPID_FOLLOW_UP_MS;
			if (!pattern && !rapid) continue;
			for (const periodName of periodsFor(owner.timestamp, bounds)) {
				const period = data[periodName];
				const cell = getCell(period, owner.taskType, owner.provider, owner.model);
				if (pattern) {
					cell.corrections++;
					period.totals.corrections++;
				} else {
					cell.rapidFollowUps++;
					period.totals.rapidFollowUps++;
				}
			}
			if (pattern) matches.push({
				sessionId: owner.sessionId,
				taskType: owner.taskType,
				provider: owner.provider,
				model: owner.model,
				assistantTimestamp: owner.timestamp,
				userTimestamp: followUp.userTimestamp,
				pattern,
				text: followUp.text,
			});
		}
	}
	for (const period of TAB_ORDER) data[period].totals.sessions = periodSessions[period].size;
	return { data, matches };
}

export async function collectCorrectionUsageData(options: CollectCorrectionOptions): Promise<CorrectionCollection> {
	const states = await loadUsageCache(options.usageCachePath ?? getDefaultCachePath());
	const [scans, taskTypes] = await Promise.all([
		currentScans(states, options.correctionCachePath ?? getDefaultCorrectionCachePath(), options.signal),
		loadTaskTypes(options.classificationCachePath ?? getDefaultClassificationCachePath()),
	]);
	return aggregate(scans, taskTypes, options.usageData.bounds);
}

export function correctionRows(stats: CorrectionPeriodStats): CorrectionRow[] {
	return Array.from(stats.cells.values())
		.sort((a, b) => TASK_TYPES.indexOf(a.taskType) - TASK_TYPES.indexOf(b.taskType) || b.corrections - a.corrections || b.assistantTurns - a.assistantTurns)
		.map((cell) => ({
			taskType: cell.taskType,
			provider: cell.provider,
			model: cell.model,
			sessions: cell.sessions.size,
			assistantTurns: cell.assistantTurns,
			corrections: cell.corrections,
			correctionRate: cell.assistantTurns > 0 ? cell.corrections / cell.assistantTurns : 0,
			rapidFollowUps: cell.rapidFollowUps,
			rapidFollowUpRate: cell.assistantTurns > 0 ? cell.rapidFollowUps / cell.assistantTurns : 0,
		}));
}

export function correctionCounts(
	stats: CorrectionPeriodStats,
	filter: { taskType?: TaskType; provider?: string; model?: string } = {}
): CorrectionCounts {
	const result = emptyCounts();
	for (const cell of stats.cells.values()) {
		if (filter.taskType && cell.taskType !== filter.taskType) continue;
		if (filter.provider && cell.provider !== filter.provider) continue;
		if (filter.model && cell.model !== filter.model) continue;
		result.assistantTurns += cell.assistantTurns;
		result.corrections += cell.corrections;
		result.rapidFollowUps += cell.rapidFollowUps;
	}
	return result;
}

function csvCell(value: string | number): string {
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildCorrectionCsv(stats: CorrectionPeriodStats): string {
	const lines = ["taskType,provider,model,sessions,assistantTurns,corrections,correctionRate,rapidFollowUps,rapidFollowUpRate"];
	for (const row of correctionRows(stats)) {
		lines.push([
			row.taskType, row.provider, row.model, row.sessions, row.assistantTurns, row.corrections,
			row.correctionRate, row.rapidFollowUps, row.rapidFollowUpRate,
		].map(csvCell).join(","));
	}
	return lines.join("\n") + "\n";
}
