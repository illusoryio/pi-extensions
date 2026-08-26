import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UsageData } from "./data.ts";
import {
	collectSpeedUsageData,
	percentile,
	speedRows,
	summarizeSpeed,
} from "./speed.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("speed statistics", () => {
	test("uses interpolated percentiles", () => {
		expect(percentile([10, 20], 0.25)).toBe(12.5);
		expect(percentile([10, 20], 0.5)).toBe(15);
		expect(percentile([10, 20], 0.75)).toBe(17.5);
		expect(summarizeSpeed([10, 20], [2_000, 1_000])).toEqual({
			turns: 2,
			medianTokPerSec: 15,
			p25TokPerSec: 12.5,
			p75TokPerSec: 17.5,
			medianLatencyMs: 1_500,
		});
	});

	test("scans direct boundaries, excludes outliers, and deduplicates copied history", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-usage-speed-"));
		temporaryDirectories.push(directory);
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const iso = (offset: number) => new Date(base + offset).toISOString();
		const usage = (output: number) => ({ input: 100, output, cacheRead: 0, cacheWrite: 0 });
		const entries = [
			{ type: "session", id: "s1", timestamp: iso(0), cwd: "/repo" },
			{ type: "message", id: "u1", timestamp: iso(1_000), message: { role: "user", content: "go", timestamp: base + 1_000 } },
			{ type: "message", id: "a1", timestamp: iso(3_000), message: { role: "assistant", provider: "p", model: "m", usage: usage(20), timestamp: base + 1_100 } },
			{ type: "message", id: "t1", timestamp: iso(3_500), message: { role: "toolResult", content: [], timestamp: base + 3_500 } },
			{ type: "message", id: "a2", timestamp: iso(4_500), message: { role: "assistant", provider: "p", model: "m", usage: usage(20), timestamp: base + 3_600 } },
			// Consecutive assistants do not reuse the prior tool boundary.
			{ type: "message", id: "a3", timestamp: iso(5_000), message: { role: "assistant", provider: "p", model: "m", usage: usage(100), timestamp: base + 4_600 } },
			{ type: "message", id: "u2", timestamp: iso(6_000), message: { role: "user", content: "again", timestamp: base + 6_000 } },
			{ type: "message", id: "a4", timestamp: iso(6_000), message: { role: "assistant", provider: "p", model: "m", usage: usage(10), timestamp: base + 6_000 } },
			{ type: "message", id: "u3", timestamp: iso(7_000), message: { role: "user", content: "again", timestamp: base + 7_000 } },
			{ type: "message", id: "a5", timestamp: iso(8_000), message: { role: "assistant", provider: "p", model: "m", usage: usage(0), timestamp: base + 7_100 } },
			{ type: "message", id: "u4", timestamp: iso(9_000), message: { role: "user", content: "again", timestamp: base + 9_000 } },
			{ type: "message", id: "a6", timestamp: iso(609_001), message: { role: "assistant", provider: "p", model: "m", usage: usage(10), timestamp: base + 9_100 } },
		];
		const content = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		const sessionA = join(directory, "a.jsonl");
		const sessionB = join(directory, "b.jsonl");
		await Promise.all([writeFile(sessionA, content), writeFile(sessionB, content)]);
		const [statA, statB] = await Promise.all([stat(sessionA), stat(sessionB)]);
		const usageCachePath = join(directory, "usage-cache.json");
		await writeFile(usageCachePath, JSON.stringify({
			version: 5,
			names: [],
			files: {
				[sessionA]: { size: statA.size, mtimeMs: statA.mtimeMs, sessionId: "s1", cwd: "/repo", messages: [], toolUsages: [] },
				[sessionB]: { size: statB.size, mtimeMs: statB.mtimeMs, sessionId: "s1", cwd: "/repo", messages: [], toolUsages: [] },
			},
		}));
		const classificationCachePath = join(directory, "classifications.json");
		await writeFile(classificationCachePath, JSON.stringify({ sessions: { s1: { taskType: "debug" } } }));
		const usageData = {
			bounds: {
				todayMs: base,
				weekStartMs: base,
				lastWeekStartMs: base - 7 * 86_400_000,
				last30DaysStartMs: base - 30 * 86_400_000,
				nowMs: base + 1_000_000,
			},
		} as UsageData;
		const result = await collectSpeedUsageData({
			usageData,
			usageCachePath,
			classificationCachePath,
			speedCachePath: join(directory, "speed-cache.json"),
		});

		expect(speedRows(result.data.allTime)).toEqual([{
			taskType: "debug",
			provider: "p",
			model: "m",
			sessions: 1,
			turns: 2,
			medianTokPerSec: 15,
			p25TokPerSec: 12.5,
			p75TokPerSec: 17.5,
			medianLatencyMs: 1_500,
		}]);
		expect(result.exclusions).toEqual({
			nonPositiveLatency: 1,
			overTenMinutes: 1,
			zeroOutputTokens: 1,
		});
	});
});
