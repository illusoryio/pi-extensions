import assert from "node:assert/strict";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap from "../index.ts";

const calls = [];

function stubApi(api) {
	const capture = (entrypoint) => (_model, _context, options) => {
		calls.push({ api, entrypoint, options });
		return {
			result: async () => ({ role: "assistant", content: [{ type: "text", text: "Recap text." }] }),
		};
	};
	registerApiProvider({ api, stream: capture("stream"), streamSimple: capture("streamSimple") });
}

stubApi("openai-codex-responses");
stubApi("anthropic-messages");

const branch = [
	{ type: "message", message: { role: "user", content: "Please fix the bridge integration." } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "I inspected the integration and prepared the next change." }],
		},
	},
];

function makeCtx(api, id) {
	return {
		hasUI: true,
		model: {
			id,
			name: id,
			api,
			provider: api === "anthropic-messages" ? "anthropic" : "openai-codex",
			baseUrl: "http://localhost.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
		},
		modelRegistry: {
			find: () => undefined,
			getAvailable: () => [],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "unused" }),
		},
		sessionManager: {
			getBranch: () => branch,
			buildContextEntries: () => branch,
		},
		ui: {
			setStatus() {},
			setWidget() {},
			theme: { fg: (_name, text) => text, bold: (text) => text },
		},
	};
}

const pi = { on() {}, registerCommand() {}, registerFlag() {}, getFlag: () => undefined, commands: new Map() };
pi.registerCommand = (name, command) => pi.commands.set(name, command);
sessionRecap(pi);
const recap = pi.commands.get("recap").handler;

await recap("", makeCtx("openai-codex-responses", "gpt-5.6-luna"));
await recap("", makeCtx("anthropic-messages", "claude-haiku-4-5"));

// Codex ignores an absent reasoning level and applies its server-side default,
// so recaps must send an explicit "none" — which only `complete`/`stream` accepts.
assert.deepEqual(
	calls.map((call) => [call.api, call.entrypoint, call.options.reasoningEffort]),
	[
		["openai-codex-responses", "stream", "none"],
		["anthropic-messages", "streamSimple", undefined],
	],
);

console.log("reasoning-off test passed");
