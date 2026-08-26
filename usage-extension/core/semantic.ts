import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getAgentDir } from "./data.ts";

export const SEMANTIC_LABELS = ["correction", "redirect", "clarification", "new-task", "acknowledgment"] as const;
export type SemanticLabel = (typeof SEMANTIC_LABELS)[number];

export interface SemanticTaskVerdict {
	taskType: string;
	confidence: number;
	source: "heuristic" | "llm";
	/** Classifier model when source is "llm". */
	model?: string;
}

export interface SemanticCorrectionVerdict {
	label: SemanticLabel;
	confidence: number;
	model?: string;
	/** Reasoning effort the classifier ran with. */
	reasoning?: string;
}

export interface SemanticSessionCacheEntry {
	taskMtimeMs?: number;
	task?: SemanticTaskVerdict;
	correctionMtimeMs?: number;
	correctionCandidateCount?: number;
	correctionsComplete?: boolean;
	corrections?: Record<string, SemanticCorrectionVerdict>;
}

export interface SemanticSpend {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface SemanticCacheFile {
	version: 1;
	model: string;
	sessions: Record<string, SemanticSessionCacheEntry>;
	spend: SemanticSpend;
}

export interface SemanticModelConfig {
	baseUrl: string;
	apiKey: string;
	inputCostPerMillion: number;
	outputCostPerMillion: number;
	/** OpenRouter provider routing preferences, when configured in models.json. */
	routing?: Record<string, unknown>;
}

export interface StrictToolRequest {
	system: string;
	user: string;
	toolName: string;
	description: string;
	schema: Record<string, unknown>;
	maxTokens?: number;
	signal?: AbortSignal;
	/** Reasoning effort sent to the provider. "none" forces the strict tool call. */
	reasoning?: string;
}

export interface StrictToolResult<T> {
	value: T;
	spend: SemanticSpend;
}

const CACHE_VERSION = 1;
export const SEMANTIC_MODEL_ID = "deepseek-v4-flash-vision-exp";
export const SEMANTIC_MODEL_PROVIDER = "deepseek";

export function getDefaultSemanticCachePath(): string {
	return join(getAgentDir(), "pi-usage-cache", "semantic.json");
}

function emptySpend(): SemanticSpend {
	return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function emptySemanticCache(): SemanticCacheFile {
	return { version: CACHE_VERSION, model: SEMANTIC_MODEL_ID, sessions: {}, spend: emptySpend() };
}

function isSemanticLabel(value: unknown): value is SemanticLabel {
	return typeof value === "string" && SEMANTIC_LABELS.includes(value as SemanticLabel);
}

export async function loadSemanticCache(path = getDefaultSemanticCachePath()): Promise<SemanticCacheFile> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SemanticCacheFile>;
		if (parsed.version !== CACHE_VERSION || !parsed.sessions || typeof parsed.sessions !== "object") {
			return emptySemanticCache();
		}
		const cache = emptySemanticCache();
		for (const [sessionId, raw] of Object.entries(parsed.sessions)) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as SemanticSessionCacheEntry;
			const corrections: Record<string, SemanticCorrectionVerdict> = {};
			for (const [messageId, verdict] of Object.entries(entry.corrections ?? {})) {
				if (!verdict || !isSemanticLabel(verdict.label) || typeof verdict.confidence !== "number") continue;
				corrections[messageId] = verdict;
			}
			cache.sessions[sessionId] = { ...entry, corrections };
		}
		const spend = parsed.spend;
		if (spend && typeof spend.requests === "number" && typeof spend.inputTokens === "number" &&
			typeof spend.outputTokens === "number" && typeof spend.costUsd === "number") cache.spend = spend;
		return cache;
	} catch {
		return emptySemanticCache();
	}
}

export async function saveSemanticCache(cache: SemanticCacheFile, path = getDefaultSemanticCachePath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	await writeFile(temporary, JSON.stringify(cache));
	await rename(temporary, path);
}

export function addSemanticSpend(cache: SemanticCacheFile, spend: SemanticSpend): void {
	cache.spend.requests += spend.requests;
	cache.spend.inputTokens += spend.inputTokens;
	cache.spend.outputTokens += spend.outputTokens;
	cache.spend.costUsd += spend.costUsd;
}

export async function resolveSemanticModelConfig(): Promise<SemanticModelConfig> {
	const path = join(homedir(), ".pi", "agent", "models.json");
	const root = JSON.parse(await readFile(path, "utf8"));
	const provider = root?.providers?.[SEMANTIC_MODEL_PROVIDER];
	const model = provider?.models?.find((candidate: { id?: unknown }) => candidate.id === SEMANTIC_MODEL_ID);
	if (!model) throw new Error(`${SEMANTIC_MODEL_PROVIDER}/${SEMANTIC_MODEL_ID} is not configured in ${path}`);
	if (provider.api !== "openai-completions" || typeof provider.baseUrl !== "string") {
		throw new Error(`${SEMANTIC_MODEL_PROVIDER} must use the openai-completions API with a baseUrl`);
	}
	const configured = provider.apiKey;
	if (typeof configured !== "string" || !configured.trim()) throw new Error(`${SEMANTIC_MODEL_PROVIDER}.apiKey is missing in ${path}`);
	let apiKey = configured.trim();
	const envMatch = apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
	if (envMatch) apiKey = process.env[envMatch[1]!] ?? "";
	else if (apiKey.startsWith("!cat ")) apiKey = (await readFile(apiKey.slice(5).trim(), "utf8")).trim();
	else if (apiKey.startsWith("!")) throw new Error("pi-usage supports !cat key references only");
	if (!apiKey) throw new Error(`${SEMANTIC_MODEL_PROVIDER}.apiKey from ${path} could not be resolved`);
	return {
		baseUrl: provider.baseUrl,
		apiKey,
		inputCostPerMillion: Number(model.cost?.input ?? 0),
		outputCostPerMillion: Number(model.cost?.output ?? 0),
		routing: model.compat?.openRouterRouting,
	};
}

function usageNumber(usage: Record<string, unknown> | undefined, ...keys: string[]): number {
	for (const key of keys) {
		const value = Number(usage?.[key]);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	return 0;
}

export async function callSemanticStrictTool<T>(config: SemanticModelConfig, request: StrictToolRequest): Promise<StrictToolResult<T>> {
	let response: Response | null = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
		if (request.signal?.aborted) throw new Error("aborted");
		try {
			response = await fetch(config.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
		body: JSON.stringify({
			model: SEMANTIC_MODEL_ID,
			messages: [
				{ role: "system", content: request.system },
				{ role: "user", content: request.user },
			],
			tools: [{ type: "function", function: {
				name: request.toolName,
				strict: true,
				description: request.description,
				parameters: request.schema,
			} }],
			// DeepSeek thinking mode rejects forced tool_choice (400 "Thinking mode does
			// not support this tool_choice"). With reasoning on we offer tools and parse
			// the first tool call; with reasoning off the strict call is forced.
			...(request.reasoning === "none" ? { tool_choice: { type: "function", function: { name: request.toolName } } } : {}),
			reasoning_effort: request.reasoning,
			...(config.routing ? { provider: config.routing } : {}),
			max_tokens: request.maxTokens ?? 16_000,
		}),
				// A hung request is retried like a transient error instead of stalling the pass.
				signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000),
			});
		} catch (error) {
			if (request.signal?.aborted) throw error;
			if (attempt === 3) throw error;
			continue;
		}
		// Transient gateway/availability errors are retried with backoff; 4xx
		// request errors fail immediately.
		if (response.ok || (response.status < 500 && response.status !== 429)) break;
	}
	if (!response!.ok) throw new Error(`Semantic provider HTTP ${response!.status}: ${(await response!.text()).slice(0, 500)}`);
	const payload = await response.json();
	const rawArgs = payload?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
	let parsedArgs: unknown;
	if (typeof rawArgs === "string") {
		try { parsedArgs = JSON.parse(rawArgs); } catch { parsedArgs = undefined; }
	} else if (typeof payload?.choices?.[0]?.message?.content === "string") {
		// Thinking-mode responses may answer in content; try strict JSON there too.
		try { parsedArgs = JSON.parse(payload.choices[0].message.content); } catch { parsedArgs = undefined; }
	}
	if (parsedArgs === undefined) {
		const diagnostic = JSON.stringify(payload?.choices?.[0]?.message ?? payload).slice(0, 800);
		throw new Error(`Semantic provider request returned no strict tool call: ${diagnostic}`);
	}
	const usage = payload?.usage as Record<string, unknown> | undefined;
	const inputTokens = usageNumber(usage, "prompt_tokens", "input_tokens");
	const outputTokens = usageNumber(usage, "completion_tokens", "output_tokens");
	let costUsd = usageNumber(usage, "cost", "total_cost", "cost_usd");
	if (costUsd === 0) {
		costUsd = inputTokens * config.inputCostPerMillion / 1_000_000 + outputTokens * config.outputCostPerMillion / 1_000_000;
	}
	return {
		value: parsedArgs as T,
		spend: { requests: 1, inputTokens, outputTokens, costUsd },
	};
}

export function estimateSemanticCost(
	inputCharacters: number,
	verdictCount: number,
	config: Pick<SemanticModelConfig, "inputCostPerMillion" | "outputCostPerMillion">
): { inputTokens: number; outputTokens: number; costUsd: number } {
	// Conservative rough estimate: JSON/prompt text averages ~4 chars/token and
	// strict verdict objects average ~18 output tokens each.
	const inputTokens = Math.ceil(inputCharacters / 4);
	const outputTokens = verdictCount * 18;
	return {
		inputTokens,
		outputTokens,
		costUsd: inputTokens * config.inputCostPerMillion / 1_000_000 + outputTokens * config.outputCostPerMillion / 1_000_000,
	};
}
