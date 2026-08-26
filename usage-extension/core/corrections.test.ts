import { describe, expect, test } from "bun:test";

import { correctionPattern, isShortFollowUp } from "./corrections.ts";

describe("correction detection", () => {
	test.each([
		["Fix it", "fix-it"],
		["Nope, still doesn't work", "no"],
		["Try again", "try-again"],
		["STOP editing files", "stop"],
		["You're wrong. Search KNOW.", "wrong"],
		["This is not what I asked", "not-what"],
		["Could we undo that move?", "undo"],
		["You removed the required guard", "you-damaged"],
		["Don't change the parser", "dont"],
	])("matches precise rework signal: %s", (text, expected) => {
		expect(correctionPattern(text)).toBe(expected);
	});

	test.each([
		"Correct me if I'm wrong, but is this expected?",
		"I was wrong — your first answer was right.",
		"What is wrong with Chrome install?",
		"Sorry, wrong agent, disregard.",
		"This may be the wrong play; can you compare the options?",
		"Do not redo the completed thread sweep.",
		"Here is the reflection from last session: what went wrong?",
		"No way to speed this up?",
		"No, that's fine. Go ahead with the original plan.",
		"Oops, I had you working in the wrong session and page.",
		"Sorry, I sent this to the wrong chat. Disregard it.",
		"Correction to my brief: I said ISO strings compare safely — that's wrong.",
		"Should we save this in case we want to revert later?",
	])("rejects known false-positive class: %s", (text) => {
		expect(correctionPattern(text)).toBeNull();
	});
});

describe("rapid follow-up candidate", () => {
	test("accepts concise non-empty messages", () => {
		expect(isShortFollowUp("Could you check one more file?")).toBe(true);
	});

	test("rejects empty and long messages", () => {
		expect(isShortFollowUp("   ")).toBe(false);
		expect(isShortFollowUp("word ".repeat(41))).toBe(false);
		expect(isShortFollowUp("x".repeat(241))).toBe(false);
	});
});
