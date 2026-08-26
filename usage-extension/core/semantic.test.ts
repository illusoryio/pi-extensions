import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	emptySemanticCache,
	estimateSemanticCost,
	loadSemanticCache,
	saveSemanticCache,
} from "./semantic.ts";
import { getDefaultClassificationCachePath } from "./tasks.ts";
import { getDefaultSemanticCachePath } from "./semantic.ts";
import { KNOW_1364_SEMANTIC_REGRESSION, SEMANTIC_CORRECTION_PROMPT } from "./corrections.ts";

describe("shared semantic infrastructure", () => {
	test("task classifications and corrections use one cache path", () => {
		expect(getDefaultClassificationCachePath()).toBe(getDefaultSemanticCachePath());
	});

	test("one cache round-trips both task and correction verdicts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-usage-semantic-"));
		const path = join(dir, "semantic.json");
		try {
			const cache = emptySemanticCache();
			cache.sessions.session = {
				taskMtimeMs: 1,
				task: { taskType: "debug", confidence: 0.9, source: "llm" },
				correctionMtimeMs: 1,
				correctionCandidateCount: 1,
				correctionsComplete: true,
				corrections: { message: { label: "redirect", confidence: 0.92 } },
			};
			await saveSemanticCache(cache, path);
			const loaded = await loadSemanticCache(path);
			expect(loaded.sessions.session?.task?.taskType).toBe("debug");
			expect(loaded.sessions.session?.corrections?.message?.label).toBe("redirect");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("cost estimate uses configured per-million prices", () => {
		const estimate = estimateSemanticCost(4_000_000, 100, { inputCostPerMillion: 0.09, outputCostPerMillion: 0.195 });
		expect(estimate.inputTokens).toBe(1_000_000);
		expect(estimate.outputTokens).toBe(1_800);
		expect(estimate.costUsd).toBeCloseTo(0.090351, 6);
	});
});

describe("KNOW-1364 semantic regression", () => {
	test("keeps all five stable messages and binding correction/redirect labels", () => {
		expect(KNOW_1364_SEMANTIC_REGRESSION).toHaveLength(5);
		expect(new Set(KNOW_1364_SEMANTIC_REGRESSION.map((item) => item.messageId)).size).toBe(5);
		expect(KNOW_1364_SEMANTIC_REGRESSION.map((item) => item.expected)).toEqual([
			"redirect", "correction", "correction", "correction", "correction",
		]);
		for (const item of KNOW_1364_SEMANTIC_REGRESSION) {
			expect(SEMANTIC_CORRECTION_PROMPT).toContain(item.text.split("...")[0]!.slice(0, 35));
		}
	});
});
