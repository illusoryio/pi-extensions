# session-recap — design & plan

> v0.1 guessed at Claude Code's recap design; v0.2 is informed by the actual
> implementation from the leaked Claude Code source (`tmustier/cc-inv`,
> 2026-03-31): `src/services/awaySummary.ts` + `src/hooks/useAwaySummary.ts`.

## Summary

When you've genuinely been away from a Pi session, a short recap is drafted
while you're gone and parked above the editor so it's waiting when you return.
Targets the "multi-clauding / multi-pi" workflow where several agent sessions
run in parallel tabs.

```
✦ recap
You're migrating the billing tables to the v2 schema; 4 of 7 are done and
invoices.ts still fails its FK constraint. Next: fix the foreign key on
line 142.
```

## What Claude Code actually does (from cc-inv)

| Aspect | Claude Code (leaked source) | session-recap v0.2 |
|---|---|---|
| Trigger | Blur → 5-min timer → generate while still away. Refocus cancels timer + in-flight. Timer fires mid-turn → pending bit, generate at turn end if still blurred. | Same shape, but 90s default + an extra trigger: turn ends while blurred (debounced 3s). Multi-tab agent workflows context-switch faster than CC's 5 min assumes. |
| Idle fallback | None — focus state `unknown` (no DECSET 1004) = feature off. | Kept, but only armed when the terminal has *not* demonstrated focus support (no `ESC[I`/`ESC[O` seen this session). |
| Output | Persistent dim `※` transcript system message (`away_summary` subtype), excluded from API context. | Transient widget above the editor (pi-idiomatic, non-polluting), cleared on next input. |
| Model | `getSmallFastModel()` — Haiku or `ANTHROPIC_SMALL_FAST_MODEL`. Never the active model. | Anthropic Haiku 4.5, or GPT-5.6 Luna when the active model is GPT and its provider offers Luna; otherwise the active model. `--recap-model` overrides this. |
| Context | Last **30 raw messages** + session memory, instruction appended as a user message, `skipCacheWrite: true`. | A **30-message LLM-ready window** in native roles + the initial request and latest compaction or branch summary as broader context. |
| Prompt | "Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. **Skip status reports and commit recaps.**" | Adopted verbatim, with no custom system prompt. |
| Dedupe | Max one summary per user turn (`hasSummarySinceLastUserTurn`). | Recap-prompt fingerprinting (same prompt = no new model call, even if Pi appends metadata entries). |
| In-flight abort on refocus | Yes — summary appended to transcript late would be weird. | No — a widget landing moments after return is exactly when it helps. |

## Triggers (v0.2)

| Trigger | Detection | Behaviour |
|---|---|---|
| Away timer | DECSET `?1004` focus-out, then `--recap-away-seconds` (default 90) of continuous blur | Generate and show; the widget is parked above the editor for when you return. |
| Turn ends while away | `turn_end` while blurred, debounced `3s` | The prime multi-tab moment: the agent finished while you were in another tab. Debounce lets mid-loop `turn_end`→`turn_start` pairs pass without drafting. |
| Idle fallback | `setTimeout` armed on `turn_end`, **only when focus reporting is unproven** | Generate after `--recap-idle-seconds` (default 120) of no input. Covers terminals without `?1004`. Disarmed permanently once a real focus event is seen. |
| `/resume` / `/fork` | `session_start { reason: "resume" \| "fork" }` | Auto-recap the prior session so you know where you left off. |
| Manual | `/recap` command | Generate now, bypass the activity gate. |

All triggers share one in-flight slot (`AbortController`); the next `input`,
`agent_start`, or `turn_start` cancels drafts and clears the widget.

Removed from v0.1: draft-on-every-focus-out + reveal-on-focus-in with a
min-away threshold (`--recap-focus-min-seconds`). That design fired a model
call on every alt-tab and cancelled most of them; the blur-timer model spends
one call only after a genuine absence, and the park/reveal/cancel machinery
(`pendingRecap`, quick-glance suppression) disappears entirely.

### Focus-out during long-running agent activity

Unchanged from v0.1, and matches CC's pending bit: if an away/post-turn
trigger fires while a turn is still loading, generation is deferred to
`agent_end` (if still blurred). `--recap-during-active` opts back into
mid-flight drafts.

## Display

- `ctx.ui.setWidget("session-recap", [...], { placement: "aboveEditor" })`
- Accent-bold `✦ recap` header + a dim body that the TUI reflows to the current terminal width.
- Cleared on: user input, new turn start, session reload, session shutdown.
- **No session persistence.** CC appends a transcript message instead; for pi
  a widget is idiomatic and avoids polluting the session file.

## Model selection

Selection order:

1. Explicit `--recap-model "<provider>/<id>"` override.
2. `anthropic/claude-haiku-4-5` when Anthropic is the active provider.
3. GPT-5.6 Luna when the active model is GPT and its provider offers Luna.
4. The active model.

Haiku is deliberately Anthropic-only. Luna is limited to GPT sessions and stays
on the active provider. Automatic choices use only available models.
Calls use no tools and request no reasoning level, with
`cacheRetention: "none"` and `maxTokens: 256`.
No model or failed auth resolution skips the recap silently.

`apiKey` may legitimately be absent when auth succeeds for env or ambient-auth
providers. The resolved headers and environment are passed to `completeSimple`.

> **Import note:** as of pi 0.80.x, `completeSimple` lives in
> `@earendil-works/pi-ai/compat`; the root export dropped it.

## Context fed to the model

The recap call follows Claude Code's structure: a 30-message recent window is
converted through Pi's normal LLM-context path and kept in its native user,
assistant, and tool-result roles, followed by the recap instruction as a user
message. When available, the initial request and latest compaction or branch
summary are prepended to that final instruction as broader context. Initial
requests longer than 8,000 characters keep their first and last 4,000.

Compaction and branch summaries are supplied once rather than duplicated in
the recent message window. Tool results keep their first and last 2,000
characters. A window boundary that falls inside a group of tool results
expands to include their assistant tool call; an assistant-led window gets a
short synthetic user boundary for provider compatibility.

## Prompt

The instruction is appended after the recent messages, following Claude Code
verbatim. No custom system prompt is added.

```
The user stepped away and is coming back. Write exactly 1-3 short sentences.
Start by stating the high-level task — what they are building or debugging,
not implementation details. Next: the concrete next step. Skip status reports
and commit recaps.
```

Post-processing only collapses whitespace; `maxTokens: 256` bounds the response.

## Edge cases

1. **Turn still running when a trigger fires** — deferred to `agent_end` via
   the pending bit (CC-equivalent). `--recap-during-active` opts out.
2. **Repeated blur/refocus with no new activity** — recap-prompt fingerprinting skips
   regeneration. The fingerprint is derived from the exact recap context sent
   to the model, not from the raw session leaf, so metadata-only entries do not
   spend another call.
3. **Errored/aborted turns** — triggers arm on `turn_end`, which fires
   regardless of outcome.
4. **Terminal without DECSET `?1004`** — idle fallback covers it, and only
   runs there: the first real focus event disarms the idle path for the
   session. Caveat: on a supporting terminal where the user never switches
   focus, the idle path stays armed (indistinguishable) — acceptable, since
   the recap is then merely redundant, and the 120s default keeps it rare.
5. **tmux** — needs `set -g focus-events on`; documented in README. Idle
   fallback covers it otherwise.
6. **User returns mid-draft** — the draft finishes and shows; it was triggered
   by a genuine absence and lands at the "just got back" moment. Typing
   cancels and clears as always.
7. **Branch advances during a draft** — the recap prompt fingerprint is
   snapshotted before the model call; stale drafts are discarded only when the
   recap-relevant transcript changed. Metadata-only leaf changes remain valid.

## Non-goals

- Session persistence of recap history (CC does persist; see Display).
- Multi-recap / rolling summary across many focus cycles.
- Recap UI beyond the widget (no modal, no notifications).

## Follow-ups (v0.3+)

- [ ] Optional e2e harness driving fake focus sequences + `turn_end` events
      and asserting widget state transitions (manual tmux testing works but is
      tedious).
