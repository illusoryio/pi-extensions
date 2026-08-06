/**
 * session-recap
 *
 * "While you were away" recap for pi, modelled on Claude Code's away-summary
 * (services/awaySummary.ts + hooks/useAwaySummary.ts). A recap is only drafted
 * after a *genuine* absence, and is waiting above the editor when you return:
 *
 *   1) Away timer: terminal focus reporting via DECSET ?1004. After the
 *      terminal has been continuously blurred for `--recap-away-seconds`
 *      (default 90s), a recap is generated and shown so it's parked above
 *      the editor when you refocus.
 *
 *   2) Turn-end while away: if a turn finishes while the terminal is blurred
 *      (the prime multi-tab moment — the agent finished while you were in
 *      another tab), a recap is drafted after a short debounce.
 *
 *   3) Idle fallback: only when the terminal has not demonstrated focus
 *      reporting support (no ESC[I / ESC[O seen this session). N seconds
 *      after the last `turn_end` with no input, generate anyway. `turn_end`
 *      (not `agent_end`) is used so this fires even for errored/aborted turns.
 *
 * Also fires on `/resume` / `/fork` (session_start reason) to recap where the
 * prior session left off.
 *
 * Recap content follows Claude Code's prompt philosophy: state the high-level
 * task first (what the user is building/fixing), then the concrete next step.
 * Skip status reports — the last assistant message is already on screen; what
 * the user has lost is the task thread.
 *
 * Model: uses Claude Haiku 4.5 for Anthropic sessions, or GPT-5.6 Luna when
 * the active model is GPT and its provider offers Luna. Otherwise it keeps
 * the active model. No reasoning level is requested; cache writes are
 * disabled. Override with `--recap-model "<provider>/<id>"`.
 *
 * Flags:
 *   --recap-away-seconds <n>   Continuous blur before an away recap (default 90)
 *   --recap-idle-seconds <n>   Idle-fallback delay after turn_end (default 120)
 *   --recap-disable-focus      Disable DECSET ?1004 focus reporting
 *   --recap-during-active      Allow away recaps while an agent turn is running
 *   --recap-disable            Disable the automatic recap entirely
 *   --recap-model <p/id>       Override automatic model selection
 *
 * Command:
 *   /recap                     Force-generate a recap right now
 */

import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type Model = Parameters<typeof completeSimple>[0];

type RecapContext = {
	messages: Message[];
	broaderContext?: string;
};

type RecapReason = "idle" | "manual" | "resume" | "focus";

const WIDGET_KEY = "session-recap";
const STATUS_KEY = "session-recap";

const DEFAULT_AWAY_SECONDS = 90;
const DEFAULT_IDLE_SECONDS = 120;
const ANTHROPIC_RECAP_MODEL = "claude-haiku-4-5";
const GPT_MODEL_ID = /(?:^|\/)gpt-/;
const LUNA_RECAP_MODEL = /(?:^|\/)gpt-5[.-]6-luna(?:$|[@:])/;

// Debounce after a turn ends while blurred, so mid-loop turn_ends (which are
// immediately followed by the next turn_start) don't trigger drafts.
const POST_TURN_DEBOUNCE_MS = 3000;

const RECENT_MESSAGE_WINDOW = 30;
const INITIAL_TASK_EDGE_CHARS = 4000;
const TOOL_RESULT_EDGE_CHARS = 2000;
const EARLIER_CONTEXT_MARKER = "(Earlier conversation omitted.)";

// DECSET 1004 focus reporting — https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN_SEQ = "\x1b[I";
const FOCUS_OUT_SEQ = "\x1b[O";

// --- helpers -----------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const b = part as ContentBlock;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const b = part as ContentBlock;
		if (b.type !== "toolCall" || typeof b.name !== "string") continue;
		const args = b.arguments ?? {};
		const summary = JSON.stringify(args).slice(0, 280);
		out.push(`- ${b.name}(${summary})`);
	}
	return out;
}

export function buildRecapContext(
	contextEntries: SessionEntry[],
	branchEntries: SessionEntry[],
): RecapContext {
	let summary: string | undefined;
	for (let i = contextEntries.length - 1; i >= 0; i--) {
		const entry = contextEntries[i];
		const candidate =
			entry.type === "compaction" || entry.type === "branch_summary" ? entry.summary?.trim() : undefined;
		if (candidate) {
			summary = candidate;
			break;
		}
	}

	let initialTask: string | undefined;
	for (const entry of branchEntries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		initialTask = extractText(entry.message.content).trim() || undefined;
		break;
	}

	const messages = convertToLlm(
		contextEntries
			.filter((entry) => entry.type !== "compaction" && entry.type !== "branch_summary")
			.flatMap(sessionEntryToContextMessages),
	).map((message) => {
		if (message.role !== "toolResult") return message;
		return {
			...message,
			content: message.content.map((block) => {
				if (block.type !== "text" || block.text.length <= TOOL_RESULT_EDGE_CHARS * 2) return block;
				return {
					...block,
					text: `${block.text.slice(0, TOOL_RESULT_EDGE_CHARS)}\n… [tool result truncated for recap] …\n${block.text.slice(-TOOL_RESULT_EDGE_CHARS)}`,
				};
			}),
		};
	});
	let start = Math.max(0, messages.length - RECENT_MESSAGE_WINDOW);
	while (start > 0 && messages[start]?.role === "toolResult") start--;
	let recentMessages = messages.slice(start);
	while (recentMessages[0]?.role === "toolResult") recentMessages = recentMessages.slice(1);
	if (recentMessages[0]?.role === "assistant") {
		recentMessages = [
			{
				role: "user",
				content: EARLIER_CONTEXT_MARKER,
				timestamp: recentMessages[0].timestamp,
			},
			...recentMessages,
		];
	}

	const broader: string[] = [];
	const initialTaskInRecent = recentMessages.some(
		(message) => message.role === "user" && extractText(message.content).trim() === initialTask,
	);
	if (initialTask && !initialTaskInRecent) {
		const framedInitialTask =
			initialTask.length <= INITIAL_TASK_EDGE_CHARS * 2
				? initialTask
				: `${initialTask.slice(0, INITIAL_TASK_EDGE_CHARS)}\n… [middle of initial request omitted for recap] …\n${initialTask.slice(-INITIAL_TASK_EDGE_CHARS)}`;
		broader.push(`Initial user request:\n${framedInitialTask}`);
	}
	if (summary) broader.push(`Session summary:\n${summary}`);

	return {
		messages: recentMessages,
		broaderContext: broader.length > 0 ? broader.join("\n\n") : undefined,
	};
}

function recapStateKey(context: RecapContext): string {
	return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

/**
 * Only draft a recap if there has been real agent activity since the last user
 * message: at least one tool call, or ~30+ words of assistant text.
 */
function hasMeaningfulActivity(entries: SessionEntry[]): boolean {
	let lastUserIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	const tail = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries;
	let assistantWords = 0;
	let toolCalls = 0;
	for (const e of tail) {
		if (e.type !== "message") continue;
		if (e.message.role === "assistant") {
			const t = extractText(e.message.content);
			assistantWords += t.split(/\s+/).filter(Boolean).length;
			toolCalls += extractToolCalls(e.message.content).length;
		}
	}
	return toolCalls > 0 || assistantWords >= 30;
}

export function selectRecapModel(
	activeModel: Model | undefined,
	overrideSpec: string | undefined,
	registry: Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable">,
): Model | undefined {
	if (overrideSpec) {
		const slash = overrideSpec.indexOf("/");
		if (slash <= 0) return activeModel;
		return registry.find(overrideSpec.slice(0, slash), overrideSpec.slice(slash + 1)) ?? activeModel;
	}
	if (!activeModel) return undefined;

	const available = registry
		.getAvailable()
		.filter((model) => model.provider === activeModel.provider);
	if (activeModel.provider === "anthropic") {
		return available.find((model) => model.id === ANTHROPIC_RECAP_MODEL) ?? activeModel;
	}
	if (!GPT_MODEL_ID.test(activeModel.id)) return activeModel;
	return available.find((model) => LUNA_RECAP_MODEL.test(model.id)) ?? activeModel;
}

async function generateRecap(
	recapContext: RecapContext,
	ctx: ExtensionContext,
	overrideSpec: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const model = selectRecapModel(ctx.model, overrideSpec, ctx.modelRegistry);
	if (!model) return undefined;

	// Note: apiKey may legitimately be absent for env/ambient-auth providers —
	// only bail when auth resolution itself failed.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok) return undefined;

	const prompt =
		(recapContext.broaderContext
			? `Broader session context:\n${recapContext.broaderContext}\n\n`
			: "") +
		"The user stepped away and is coming back. Write exactly 1-3 short sentences. " +
		"Start by stating the high-level task — what they are building or debugging, not " +
		"implementation details. Next: the concrete next step. Skip status reports and commit recaps.";

	let response;
	try {
		response = await completeSimple(
			model,
			{
				systemPrompt: "",
				messages: [
					...recapContext.messages,
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				cacheRetention: "none",
				maxTokens: 256,
			},
		);
	} catch (err) {
		// Custom providers registered only with pi (e.g. via a bridge extension)
		// are unknown to pi-ai's compat provider registry, so completeSimple
		// cannot route the call. Skip the recap silently, matching the documented
		// "failed auth resolution → skipped silently" behavior.
		if (err instanceof Error && err.message.startsWith("No API provider registered for api:")) {
			return undefined;
		}
		throw err;
	}

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	return text || undefined;
}

function showRecap(ctx: ExtensionContext, recap: string) {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const header = theme.fg("accent", theme.bold("✦ recap"));
	ctx.ui.setWidget(WIDGET_KEY, [header, theme.fg("dim", recap)], { placement: "aboveEditor" });
}

function clearRecap(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

// --- extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("recap-away-seconds", {
		description: "Seconds of continuous terminal blur before an away recap is generated",
		type: "string",
		default: String(DEFAULT_AWAY_SECONDS),
	});
	pi.registerFlag("recap-idle-seconds", {
		description:
			"Idle-fallback: seconds after turn_end before a recap when the terminal doesn't report focus",
		type: "string",
		default: String(DEFAULT_IDLE_SECONDS),
	});
	pi.registerFlag("recap-disable-focus", {
		description: "Disable DECSET ?1004 focus reporting (idle fallback still runs)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-during-active", {
		description: "Allow away recaps while an agent turn is still running",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-disable", {
		description: "Disable the automatic session recap",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("recap-model", {
		description: "Override automatic model selection, e.g. anthropic/claude-sonnet-4-6",
		type: "string",
		default: "",
	});

	// Timers. Only one recap request is ever in flight; starting a new one
	// aborts the previous.
	let idleTimer: NodeJS.Timeout | undefined; // fallback for no-focus-support terminals
	let awayTimer: NodeJS.Timeout | undefined; // continuous-blur timer
	let postTurnTimer: NodeJS.Timeout | undefined; // turn ended while blurred
	let activeController: AbortController | undefined;

	// Agent activity state. Like Claude Code's away summary, we don't draft
	// while a turn is still loading: if the away/post-turn trigger fires
	// mid-turn, we set a pending bit and generate on agent_end (if still
	// blurred). This avoids summarising a half-written branch.
	let agentActive = false;
	let focusDraftAfterAgent = false;

	// Focus reporting state.
	let focusListener: ((chunk: Buffer) => void) | undefined;
	let focusEnabled = false;
	let focusedOutAt: number | undefined;
	// True once we've seen any ESC[I / ESC[O this session — i.e. the terminal
	// demonstrably supports focus reporting, so the idle fallback is redundant.
	let focusEventsSeen = false;

	// Fingerprint of the recap-relevant transcript we last drafted. This is more
	// precise than the raw branch leaf: Pi appends metadata entries such as
	// session names, model/thinking changes, labels, or leaf markers that can
	// advance the leaf without changing the recap prompt at all.
	let lastDraftedStateKey: string | undefined;

	const awayMs = (): number => {
		const n = Number(pi.getFlag("recap-away-seconds") ?? DEFAULT_AWAY_SECONDS);
		return Math.max(5, Number.isFinite(n) ? n : DEFAULT_AWAY_SECONDS) * 1000;
	};
	const idleMs = (): number => {
		const n = Number(pi.getFlag("recap-idle-seconds") ?? DEFAULT_IDLE_SECONDS);
		return Math.max(5, Number.isFinite(n) ? n : DEFAULT_IDLE_SECONDS) * 1000;
	};
	const isDisabled = (): boolean => Boolean(pi.getFlag("recap-disable"));
	const isFocusDisabled = (): boolean => Boolean(pi.getFlag("recap-disable-focus"));
	const allowDuringActive = (): boolean => Boolean(pi.getFlag("recap-during-active"));
	const modelOverride = (): string | undefined => {
		const v = String(pi.getFlag("recap-model") ?? "").trim();
		return v.length > 0 ? v : undefined;
	};

	const clearIdleTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	const clearAwayTimer = () => {
		if (awayTimer) {
			clearTimeout(awayTimer);
			awayTimer = undefined;
		}
	};
	const clearPostTurnTimer = () => {
		if (postTurnTimer) {
			clearTimeout(postTurnTimer);
			postTurnTimer = undefined;
		}
	};

	const cancelActive = () => {
		if (activeController) {
			activeController.abort();
			activeController = undefined;
		}
	};

	// The idle fallback only exists for terminals that don't report focus.
	// Once we've seen a real focus event, the away/post-turn triggers own the
	// job and the idle path would just be noise while the user is watching.
	const idleFallbackEligible = (): boolean =>
		!focusEnabled || isFocusDisabled() || !focusEventsSeen;

	const generateAndShow = async (ctx: ExtensionContext, opts: { reason: RecapReason }) => {
		const entries = ctx.sessionManager.getBranch();
		if (!hasMeaningfulActivity(entries) && opts.reason !== "manual") return;

		const recapContext = buildRecapContext(ctx.sessionManager.buildContextEntries(), entries);
		if (recapContext.messages.length === 0 && !recapContext.broaderContext) return;

		// Snapshot the exact recap prompt we're summarising BEFORE we await. If
		// recap-relevant content changes while the model call is in flight, discard
		// the stale draft; metadata-only leaf changes should not invalidate it.
		const startStateKey = recapStateKey(recapContext);
		if (opts.reason !== "manual" && lastDraftedStateKey === startStateKey) return;

		// Take ownership of the active-request slot. Any prior request is
		// cancelled; we'll only clear shared state in the finally if we're
		// still the current owner, so a late-completing aborted call can't
		// stomp on a newer in-flight request.
		cancelActive();
		const controller = new AbortController();
		activeController = controller;

		const showStatus = opts.reason === "manual" || opts.reason === "idle";
		if (showStatus && ctx.hasUI)
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "✦ drafting recap…"));

		try {
			const recap = await generateRecap(recapContext, ctx, modelOverride(), controller.signal);
			if (!recap || controller.signal.aborted) return;
			// Discard the recap if the recap prompt changed while we were drafting.
			// If only session metadata changed, the prompt key stays the same and the
			// draft remains valid.
			const currentContext = buildRecapContext(
				ctx.sessionManager.buildContextEntries(),
				ctx.sessionManager.getBranch(),
			);
			if (recapStateKey(currentContext) !== startStateKey) return;

			// Stamp the prompt we actually summarised, not the live branch leaf.
			lastDraftedStateKey = startStateKey;
			// Another trigger has produced a recap for this content — kill the
			// other timers so we don't issue a second call later.
			clearIdleTimer();
			clearPostTurnTimer();

			// Show immediately. Away/post-turn recaps are drafted while the user
			// is away, so the widget is parked above the editor when they return;
			// if they returned mid-draft, it's still the "just got back" moment.
			showRecap(ctx, recap);
		} catch (err) {
			if (!controller.signal.aborted) console.error("[session-recap] failed:", err);
		} finally {
			if (activeController === controller) {
				activeController = undefined;
				if (showStatus && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}
	};

	// Shared gate for the away-timer / post-turn / deferred-after-agent paths.
	// Requires the terminal to still be blurred.
	const tryAwayRecap = (ctx: ExtensionContext) => {
		if (isDisabled() || !ctx.hasUI) return;
		if (focusedOutAt === undefined) return; // user came back — drop it
		if (agentActive && !allowDuringActive()) {
			// Turn still loading: defer to agent_end (Claude Code's pending bit).
			focusDraftAfterAgent = true;
			return;
		}
		if (activeController) return; // one request at a time

		// generateAndShow fingerprints the recap prompt and returns before the
		// model call when we have already drafted for the same session content.
		void generateAndShow(ctx, { reason: "focus" });
	};

	const scheduleIdleRecap = (ctx: ExtensionContext) => {
		clearIdleTimer();
		if (isDisabled() || !ctx.hasUI) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			// Re-check at fire time: a focus event may have arrived since arming.
			if (!idleFallbackEligible()) return;
			void generateAndShow(ctx, { reason: "idle" });
		}, idleMs());
	};

	// --- focus reporting wiring -------------------------------------------

	const handleFocusOut = (ctx: ExtensionContext) => {
		focusEventsSeen = true;
		focusedOutAt = Date.now();
		// Focus reporting works — the idle fallback is now redundant.
		clearIdleTimer();
		if (isDisabled()) return;
		clearAwayTimer();
		awayTimer = setTimeout(() => {
			awayTimer = undefined;
			tryAwayRecap(ctx);
		}, awayMs());
	};

	const handleFocusIn = (_ctx: ExtensionContext) => {
		focusEventsSeen = true;
		focusedOutAt = undefined;
		focusDraftAfterAgent = false;
		clearAwayTimer();
		// The user is back and looking at the output — a post-turn recap now
		// would just repeat what's on screen.
		clearPostTurnTimer();
		clearIdleTimer();
		// Note: an in-flight draft (triggered by a genuine absence) is left to
		// finish — it lands moments after return, which is exactly when it helps.
	};

	const attachFocusReporting = (ctx: ExtensionContext) => {
		if (focusEnabled || isFocusDisabled() || !ctx.hasUI) return;
		if (!process.stdout.isTTY || !process.stdin.isTTY) return;

		try {
			process.stdout.write(FOCUS_ENABLE);
		} catch {
			return;
		}

		// Scan stdin for ESC[I / ESC[O. Sequences can straddle chunks, so we
		// keep unconsumed trailing bytes in `buf` between calls. Consume each
		// match by advancing `i`, so a completed sequence never fires twice.
		// Adding a 'data' listener is safe: Node dispatches to all listeners
		// and pi is already in flowing mode — we don't steal bytes from the
		// TUI's input layer.
		const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);
		let buf = "";
		const listener = (chunk: Buffer) => {
			try {
				buf += chunk.toString("binary");
				let i = 0;
				while (i + MAX_SEQ <= buf.length) {
					if (buf.startsWith(FOCUS_IN_SEQ, i)) {
						handleFocusIn(ctx);
						i += FOCUS_IN_SEQ.length;
					} else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
						handleFocusOut(ctx);
						i += FOCUS_OUT_SEQ.length;
					} else {
						i++;
					}
				}
				buf = buf.slice(i);
				// Safety net — never let buf grow unbounded if we're reading a
				// long non-escape stream on a terminal that streams ahead of us.
				if (buf.length > 64) buf = buf.slice(-(MAX_SEQ - 1));
			} catch {
				/* best-effort */
			}
		};
		process.stdin.on("data", listener);
		focusListener = listener;
		focusEnabled = true;
	};

	const detachFocusReporting = () => {
		if (focusListener) {
			try {
				process.stdin.off("data", focusListener);
			} catch {
				/* noop */
			}
			focusListener = undefined;
		}
		if (focusEnabled) {
			try {
				process.stdout.write(FOCUS_DISABLE);
			} catch {
				/* noop */
			}
			focusEnabled = false;
		}
		focusedOutAt = undefined;
		focusDraftAfterAgent = false;
	};

	// Lifecycle: recap triggers arm on turn_end (fires even on error/abort)
	// and are cleared by anything that indicates new activity or input.

	pi.on("turn_end", async (_event, ctx) => {
		if (isDisabled() || !ctx.hasUI) return;

		// Prime multi-tab moment: the agent produced output while the user is
		// away. Debounced so mid-loop turn_ends (followed by the next
		// turn_start within moments) don't trigger drafts; tryAwayRecap also
		// defers if the agent loop is still active when the timer fires.
		if (focusedOutAt !== undefined) {
			clearPostTurnTimer();
			postTurnTimer = setTimeout(() => {
				postTurnTimer = undefined;
				tryAwayRecap(ctx);
			}, POST_TURN_DEBOUNCE_MS);
		}

		// Fallback for terminals without focus reporting.
		if (idleFallbackEligible()) scheduleIdleRecap(ctx);
	});

	pi.on("turn_start", async () => {
		// Another turn is starting in the same agent loop — any armed trigger
		// or in-flight draft is stale. The dedupe stamp itself is content-based,
		// so it does not need manual invalidation.
		clearIdleTimer();
		clearPostTurnTimer();
		cancelActive();
	});

	pi.on("input", async (_event, ctx) => {
		clearIdleTimer();
		clearPostTurnTimer();
		clearAwayTimer();
		cancelActive();
		focusDraftAfterAgent = false;
		clearRecap(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentActive = true;
		clearIdleTimer();
		clearPostTurnTimer();
		cancelActive();
		clearRecap(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentActive = false;
		if (focusDraftAfterAgent) {
			focusDraftAfterAgent = false;
			tryAwayRecap(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		agentActive = false;
		focusDraftAfterAgent = false;
		clearIdleTimer();
		clearAwayTimer();
		clearPostTurnTimer();
		cancelActive();
		detachFocusReporting();
	});

	// Session start: wire up focus reporting; on resume/fork, show a recap.
	pi.on("session_start", async (event, ctx) => {
		attachFocusReporting(ctx);
		if (isDisabled() || !ctx.hasUI) return;
		if (event.reason === "resume" || event.reason === "fork") {
			setTimeout(() => {
				void generateAndShow(ctx, { reason: "resume" });
			}, 300);
		}
	});

	// Manual command.
	pi.registerCommand("recap", {
		description: "Generate a recap of recent session activity",
		handler: async (_args, ctx) => {
			await generateAndShow(ctx, { reason: "manual" });
		},
	});
}
