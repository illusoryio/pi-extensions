import { describe, expect, test } from "bun:test";

import { classifyHeuristically } from "./tasks.ts";

function classify(firstUserMessages: string[], cwd = "/work/pi-usage") {
	return classifyHeuristically({ cwd, filePaths: ["/sessions/workers/INT-170/session.jsonl"], issueIds: ["INT-170"], firstUserMessages });
}

describe("task classification heuristics", () => {
	test("recognizes frontend work", () => {
		expect(classify(["Polish the responsive UI component and fix its CSS"]).taskType).toBe("design/frontend");
	});

	test("treats design docs as planning", () => {
		expect(classify(["Write an architecture design-doc and implementation plan"]).taskType).toBe("planning");
	});

	test("recognizes research and infrastructure", () => {
		expect(classify(["Research and benchmark the available inference APIs"]).taskType).toBe("research");
		expect(classify(["Repair the systemd deployment and CI pipeline"]).taskType).toBe("infra");
	});

	test("does not guess when no category matches", () => {
		const result = classify(["Implement Linear issue INT-170"]);
		expect(result.taskType).toBe("other");
		expect(result.confidence).toBeLessThan(0.65);
	});

	test("returns other for tied signals", () => {
		const result = classify(["Research a bug"]);
		expect(result.taskType).toBe("other");
	});
});
