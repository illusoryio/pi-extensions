/**
 * Shared Usage statistics dashboard UI
 *
 * Shows an inline view with usage stats grouped by provider.
 * - Tab cycles: Today → This Week → Last Week → All Time
 * - Arrow keys navigate providers
 * - Enter expands/collapses to show models
 *
 * Data collection and caching live in ./core/data.ts.
 */

import { Container, Spacer, matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import { getAgentDir, TAB_ORDER } from "./core/data.ts";
import type { BaseStats, ProviderStats, TabName, TotalStats, UsageData } from "./core/data.ts";
import {
	buildGraphModel,
	renderChart,
	GROUP_LABELS,
	GROUP_ORDER,
	METRIC_LABELS,
	METRIC_ORDER,
	TOTAL_SERIES_KEY,
} from "./core/graph.ts";
import type { GraphGroupBy, GraphMetric, GraphModel } from "./core/graph.ts";
import type { CorrectionCounts, CorrectionUsageData } from "./core/corrections.ts";
import { summarizeSpeed } from "./core/speed.ts";
import type { SpeedSummary, SpeedUsageData } from "./core/speed.ts";
import { buildTaskCsv, TASK_TYPES } from "./core/tasks.ts";
import type { TaskType, TaskTypeStats, TaskUsageData } from "./core/tasks.ts";
import {
	buildGraphCsv,
	buildInsightsJson,
	buildTableCsv,
	exportFileName,
	parseExportDirSetting,
	resolveExportDir,
} from "./core/export.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type UsageThemeColor = "accent" | "border" | "success" | "error" | "warning" | "muted" | "dim";

/** Minimal theme surface shared by Pi's Theme and the standalone ANSI theme. */
export interface UsageTheme {
	fg(color: UsageThemeColor, text: string): string;
	bold(text: string): string;
}

type ViewMode = "table" | "tasks" | "insights" | "graph";

const VIEW_CYCLE: ViewMode[] = ["graph", "table", "tasks", "insights"];

const VIEW_LABELS: Record<ViewMode, string> = {
	graph: "Graphs",
	table: "Table",
	tasks: "Tasks",
	insights: "Insights",
};

// =============================================================================
// Column Configuration
// =============================================================================

type DisplayStats = BaseStats & { sessions: Set<string> | number } & Partial<CorrectionCounts & SpeedSummary>;

type LensFilter = {
	taskType?: TaskType;
	provider?: string;
	model?: string;
	models?: Set<string>;
	pairs?: Set<string>;
};

interface DataColumn {
	label: string;
	width: number;
	dimmed?: boolean;
	getValue: (stats: DisplayStats) => string;
}

interface TableLayoutCandidate {
	columns: DataColumn[];
	minNameWidth: number;
	compact?: boolean;
}

interface TableLayout {
	columns: DataColumn[];
	nameWidth: number;
	tableWidth: number;
	compact: boolean;
}

const MAX_NAME_COL_WIDTH = 26;

const SESSIONS_COLUMN: DataColumn = {
	label: "Sessions",
	width: 9,
	getValue: (s) => formatNumber(typeof s.sessions === "number" ? s.sessions : s.sessions.size),
};

const MSGS_COLUMN: DataColumn = {
	label: "Msgs",
	width: 9,
	getValue: (s) => formatNumber(s.messages),
};

const CORRECTION_COLUMN: DataColumn = {
	label: "SemCorr",
	width: 9,
	getValue: (s) => {
		const turns = s.assistantTurns ?? 0;
		const corrections = s.semanticReworks ?? 0;
		if (turns === 0 || (s.semanticClassified ?? 0) === 0) return "-";
		const percent = (corrections / turns) * 100;
		return `${percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}%`;
	},
};

const SPEED_COLUMN: DataColumn = {
	label: "Tok/s",
	width: 8,
	getValue: (s) => {
		const speed = s.medianTokPerSec ?? 0;
		if (speed <= 0) return "-";
		return speed < 10 ? speed.toFixed(1) : Math.round(speed).toString();
	},
};

const COST_COLUMN: DataColumn = {
	label: "Cost",
	width: 9,
	getValue: (s) => formatCost(s.cost),
};

const TOKENS_COLUMN: DataColumn = {
	label: "Tokens",
	width: 9,
	getValue: (s) => formatTokens(s.tokens.total),
};

const INPUT_COLUMN: DataColumn = {
	label: "↑In",
	width: 8,
	dimmed: true,
	// Include cacheWrite so this reflects fresh input tokens sent this turn,
	// even for providers like Anthropic that split cached prompt creation out
	// from the regular input token count.
	getValue: (s) => formatTokens(s.tokens.input + s.tokens.cacheWrite),
};

const OUTPUT_COLUMN: DataColumn = {
	label: "↓Out",
	width: 8,
	dimmed: true,
	getValue: (s) => formatTokens(s.tokens.output),
};

const CACHE_COLUMN: DataColumn = {
	label: "Cache",
	width: 8,
	dimmed: true,
	getValue: (s) => formatTokens(s.tokens.cacheRead + s.tokens.cacheWrite),
};

const FULL_DATA_COLUMNS: DataColumn[] = [
	SESSIONS_COLUMN,
	MSGS_COLUMN,
	CORRECTION_COLUMN,
	SPEED_COLUMN,
	COST_COLUMN,
	TOKENS_COLUMN,
	INPUT_COLUMN,
	OUTPUT_COLUMN,
	CACHE_COLUMN,
];

const TABLE_LAYOUTS: TableLayoutCandidate[] = [
	{ columns: FULL_DATA_COLUMNS, minNameWidth: MAX_NAME_COL_WIDTH },
	{ columns: [SESSIONS_COLUMN, MSGS_COLUMN, CORRECTION_COLUMN, SPEED_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 14, compact: true },
	{ columns: [SESSIONS_COLUMN, CORRECTION_COLUMN, SPEED_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 12, compact: true },
	{ columns: [SPEED_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 10, compact: true },
	{ columns: [COST_COLUMN], minNameWidth: 8, compact: true },
];

// =============================================================================
// Formatting Helpers
// =============================================================================

function formatCost(cost: number): string {
	if (cost === 0) return "-";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(2)}`;
	if (cost < 10) return `$${cost.toFixed(2)}`;
	if (cost < 100) return `$${cost.toFixed(1)}`;
	return `$${Math.round(cost)}`;
}

function formatTokens(count: number): string {
	if (count === 0) return "-";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatNumber(n: number): string {
	if (n === 0) return "-";
	return n.toLocaleString();
}

// Compact axis/legend formatters for the graph view.
function formatAxisCost(v: number): string {
	if (v === 0) return "$0";
	if (v < 1) return `$${v.toFixed(2)}`;
	if (v < 100) return `$${v.toFixed(1)}`;
	if (v < 10_000) return `$${Math.round(v)}`;
	if (v < 1_000_000) return `$${(v / 1000).toFixed(1)}k`;
	return `$${(v / 1_000_000).toFixed(2)}M`;
}

function formatAxisCount(v: number): string {
	if (v === 0) return "0";
	if (v < 1000) return String(Math.round(v));
	if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
	if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	return `${(v / 1_000_000_000).toFixed(1)}B`;
}

// Bright ANSI palette for graph series (Total uses index 0).
const SERIES_COLORS = ["\x1b[97m", "\x1b[96m", "\x1b[95m", "\x1b[93m", "\x1b[92m", "\x1b[94m", "\x1b[91m", "\x1b[90m"];
const COLOR_RESET = "\x1b[39m";

function seriesColor(index: number): string {
	return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

/** "14:32" if the timestamp is today, otherwise "16 Jul" (with year if not this year). */
export function formatSinceDate(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
	if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString(undefined, opts);
}

function padLeft(s: string, len: number): string {
	const vis = visibleWidth(s);
	if (vis >= len) return s;
	return " ".repeat(len - vis) + s;
}

function padRight(s: string, len: number): string {
	const vis = visibleWidth(s);
	if (vis >= len) return s;
	return s + " ".repeat(len - vis);
}

function sumColumnWidths(columns: DataColumn[]): number {
	return columns.reduce((sum, col) => sum + col.width, 0);
}

function fitCell(s: string, len: number, align: "left" | "right" = "left"): string {
	if (len <= 0) return "";
	const truncated = truncateToWidth(s, len);
	return align === "right" ? padLeft(truncated, len) : padRight(truncated, len);
}

function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(width, 0)));
}

function pickFittingText(width: number, variants: string[]): string {
	for (const variant of variants) {
		if (visibleWidth(variant) <= width) return variant;
	}
	return variants[variants.length - 1] || "";
}

function getTableLayout(width: number): TableLayout {
	const safeWidth = Math.max(width, 0);

	for (const candidate of TABLE_LAYOUTS) {
		const columnsWidth = sumColumnWidths(candidate.columns);
		const nameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(safeWidth - columnsWidth, 0));
		if (nameWidth >= candidate.minNameWidth) {
			return {
				columns: candidate.columns,
				nameWidth,
				tableWidth: nameWidth + columnsWidth,
				compact: candidate.compact ?? false,
			};
		}
	}

	const fallback = TABLE_LAYOUTS[TABLE_LAYOUTS.length - 1]!;
	const fallbackColumnsWidth = sumColumnWidths(fallback.columns);
	const fallbackNameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(safeWidth - fallbackColumnsWidth, 0));
	return {
		columns: fallback.columns,
		nameWidth: fallbackNameWidth,
		tableWidth: fallbackNameWidth + fallbackColumnsWidth,
		compact: fallback.compact ?? false,
	};
}

// =============================================================================
// Component
// =============================================================================

const TAB_LABELS: Record<TabName, string> = {
	today: "Today",
	thisWeek: "This Week",
	lastWeek: "Last Week",
	last30Days: "Last 30 Days",
	allTime: "All Time",
};

export class UsageComponent {
	private activeTab: TabName = "allTime";
	private viewMode: ViewMode = "graph";
	private data: UsageData;
	private taskData: TaskUsageData;
	private correctionData: CorrectionUsageData;
	private speedData: SpeedUsageData;
	private selectedIndex = 0;
	private taskSelectedIndex = 0;
	private expandedTasks = new Set<TaskType>();
	private expanded = new Set<string>();
	private providerOrder: string[] = [];
	private theme: UsageTheme;
	private requestRender: () => void;
	private done: () => void;

	// Graph explorer state.
	private graphMetric: GraphMetric = "cost";
	private graphGroupBy: GraphGroupBy = "provider";
	private graphCumulative = true;
	private exportNote: { text: string; ok: boolean } | null = null;
	private tableHidden = new Set<string>();
	private tableFilter = "";
	private tableFilterEditing = false;
	private graphHidden = new Set<string>();
	private graphLegendIndex = 0;
	private speedSummaryCache = new Map<string, SpeedSummary>();

	constructor(
		theme: UsageTheme,
		data: UsageData,
		taskData: TaskUsageData,
		correctionData: CorrectionUsageData,
		speedData: SpeedUsageData,
		requestRender: () => void,
		done: () => void
	) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.data = data;
		this.taskData = taskData;
		this.correctionData = correctionData;
		this.speedData = speedData;
		this.updateProviderOrder();
	}

	private updateProviderOrder(): void {
		const stats = this.data[this.activeTab];
		this.providerOrder = Array.from(stats.providers.entries())
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(([name]) => name);
		this.clampTableSelection();
	}

	private clampTableSelection(): void {
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.visibleTable().providers.size - 1));
		this.taskSelectedIndex = Math.min(this.taskSelectedIndex, Math.max(0, this.visibleTaskTypes().length - 1));
	}

	private withCorrections<T extends BaseStats & { sessions: Set<string> | number }>(
		stats: T,
		filter: LensFilter = {}
	): T & CorrectionCounts {
		const counts: CorrectionCounts = {
			assistantTurns: 0,
			corrections: 0,
			rapidFollowUps: 0,
			semanticCandidates: 0,
			semanticClassified: 0,
			semanticCorrections: 0,
			semanticRedirects: 0,
			semanticReworks: 0,
		};
		for (const cell of this.correctionData[this.activeTab].cells.values()) {
			if (filter.taskType && cell.taskType !== filter.taskType) continue;
			if (filter.provider && cell.provider !== filter.provider) continue;
			if (filter.model && cell.model !== filter.model) continue;
			if (filter.models && !filter.models.has(cell.model)) continue;
			if (filter.pairs && !filter.pairs.has(`${cell.provider}\u0000${cell.model}`)) continue;
			counts.assistantTurns += cell.assistantTurns;
			counts.corrections += cell.corrections;
			counts.rapidFollowUps += cell.rapidFollowUps;
			counts.semanticCandidates += cell.semanticCandidates;
			counts.semanticClassified += cell.semanticClassified;
			counts.semanticCorrections += cell.semanticCorrections;
			counts.semanticRedirects += cell.semanticRedirects;
			counts.semanticReworks += cell.semanticReworks;
		}
		return Object.assign({}, stats, counts);
	}

	private withLenses<T extends BaseStats & { sessions: Set<string> | number }>(stats: T, filter: LensFilter = {}): DisplayStats {
		const filterKey = [
			this.activeTab,
			filter.taskType ?? "",
			filter.provider ?? "",
			filter.model ?? "",
			filter.models ? Array.from(filter.models).sort().join("\u0001") : "",
			filter.pairs ? Array.from(filter.pairs).sort().join("\u0001") : "",
		].join("\u0002");
		let speed = this.speedSummaryCache.get(filterKey);
		if (!speed) {
			const rates: number[] = [];
			const latenciesMs: number[] = [];
			for (const cell of this.speedData[this.activeTab].cells.values()) {
				if (filter.taskType && cell.taskType !== filter.taskType) continue;
				if (filter.provider && cell.provider !== filter.provider) continue;
				if (filter.model && cell.model !== filter.model) continue;
				if (filter.models && !filter.models.has(cell.model)) continue;
				if (filter.pairs && !filter.pairs.has(`${cell.provider}\u0000${cell.model}`)) continue;
				for (const rate of cell.rates) rates.push(rate);
				for (const latency of cell.latenciesMs) latenciesMs.push(latency);
			}
			speed = summarizeSpeed(rates, latenciesMs);
			this.speedSummaryCache.set(filterKey, speed);
		}
		return Object.assign(this.withCorrections(stats, filter), speed);
	}

	private visibleTaskTypes(): Array<[TaskType, TaskTypeStats]> {
		const stats = this.taskData[this.activeTab];
		return TASK_TYPES
			.map((taskType) => [taskType, stats.taskTypes.get(taskType)] as const)
			.filter((entry): entry is [TaskType, NonNullable<typeof entry[1]>] => entry[1] !== undefined)
			.sort((a, b) => b[1].cost - a[1].cost);
	}

	/**
	 * The table slice after hides and the text filter. A filter matches a
	 * provider name (whole provider stays) or individual model names, in which
	 * case the provider row is synthesized from just the matching models so
	 * the totals row and exports reflect exactly what is on screen.
	 */
	private visibleTable(): { providers: Map<string, ProviderStats>; totals: TotalStats } {
		const stats = this.data[this.activeTab];
		const q = this.tableFilter.trim().toLowerCase();
		// Always iterate providerOrder so the map is cost-sorted — selection
		// indexes and rendered rows must agree on ordering.
		const providers = new Map<string, ProviderStats>();
		for (const name of this.providerOrder) {
			if (this.tableHidden.has(name)) continue;
			const full = stats.providers.get(name)!;
			if (!q || name.toLowerCase().includes(q)) {
				providers.set(name, full);
				continue;
			}
			const models = new Map(Array.from(full.models).filter(([model]) => model.toLowerCase().includes(q)));
			if (models.size === 0) continue;
			const synth: ProviderStats = {
				messages: 0,
				cost: 0,
				tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				sessions: new Set<string>(),
				models,
			};
			for (const model of models.values()) {
				synth.messages += model.messages;
				synth.cost += model.cost;
				synth.tokens.total += model.tokens.total;
				synth.tokens.input += model.tokens.input;
				synth.tokens.output += model.tokens.output;
				synth.tokens.cacheRead += model.tokens.cacheRead;
				synth.tokens.cacheWrite += model.tokens.cacheWrite;
				for (const s of model.sessions) synth.sessions.add(s);
			}
			providers.set(name, synth);
		}
		if (!q && this.tableHidden.size === 0) return { providers, totals: stats.totals };

		const totals: TotalStats = {
			sessions: 0,
			messages: 0,
			cost: 0,
			tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const sessions = new Set<string>();
		for (const provider of providers.values()) {
			totals.messages += provider.messages;
			totals.cost += provider.cost;
			totals.tokens.total += provider.tokens.total;
			totals.tokens.input += provider.tokens.input;
			totals.tokens.output += provider.tokens.output;
			totals.tokens.cacheRead += provider.tokens.cacheRead;
			totals.tokens.cacheWrite += provider.tokens.cacheWrite;
			for (const s of provider.sessions) sessions.add(s);
		}
		totals.sessions = sessions.size;
		return { providers, totals };
	}

	handleInput(data: string): void {
		// Filter typing captures printable keys, so it runs before everything.
		if (this.viewMode === "table" && this.tableFilterEditing) {
			if (matchesKey(data, "escape")) {
				this.tableFilter = "";
				this.tableFilterEditing = false;
			} else if (matchesKey(data, "enter")) {
				this.tableFilterEditing = false;
			} else if (matchesKey(data, "backspace")) {
				this.tableFilter = this.tableFilter.slice(0, -1);
			} else if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.tableFilter += data;
			}
			this.clampTableSelection();
			this.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done();
			return;
		}

		if (matchesKey(data, "v")) {
			const idx = VIEW_CYCLE.indexOf(this.viewMode);
			this.viewMode = VIEW_CYCLE[(idx + 1) % VIEW_CYCLE.length]!;
			this.exportNote = null;
			this.requestRender();
			return;
		}

		if (matchesKey(data, "e")) {
			this.exportCurrentView();
			this.requestRender();
			return;
		}

		if (this.viewMode === "graph" && this.handleGraphInput(data)) {
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.activeTab = TAB_ORDER[(idx + 1) % TAB_ORDER.length]!;
			this.updateProviderOrder();
			this.exportNote = null;
			this.requestRender();
		} else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.activeTab = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length]!;
			this.updateProviderOrder();
			this.exportNote = null;
			this.requestRender();
		} else if (this.viewMode === "graph") {
			// Graph-specific keys were handled above; swallow table-only keys.
		} else if (this.viewMode === "tasks" && matchesKey(data, "up")) {
			if (this.taskSelectedIndex > 0) this.taskSelectedIndex--;
			this.requestRender();
		} else if (this.viewMode === "tasks" && matchesKey(data, "down")) {
			if (this.taskSelectedIndex < this.visibleTaskTypes().length - 1) this.taskSelectedIndex++;
			this.requestRender();
		} else if (this.viewMode === "tasks" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
			const taskType = this.visibleTaskTypes()[this.taskSelectedIndex]?.[0];
			if (taskType) {
				if (this.expandedTasks.has(taskType)) this.expandedTasks.delete(taskType);
				else this.expandedTasks.add(taskType);
				this.requestRender();
			}
		} else if (this.viewMode === "table" && data === "/") {
			this.tableFilterEditing = true;
			this.requestRender();
		} else if (this.viewMode === "table" && data === "x") {
			const visible = Array.from(this.visibleTable().providers.keys());
			const provider = visible[this.selectedIndex];
			if (provider) {
				this.tableHidden.add(provider);
				this.clampTableSelection();
				this.requestRender();
			}
		} else if (this.viewMode === "table" && data === "a") {
			this.tableHidden.clear();
			this.tableFilter = "";
			this.tableFilterEditing = false;
			this.clampTableSelection();
			this.requestRender();
		} else if (this.viewMode === "table" && matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.requestRender();
			}
		} else if (this.viewMode === "table" && matchesKey(data, "down")) {
			if (this.selectedIndex < this.visibleTable().providers.size - 1) {
				this.selectedIndex++;
				this.requestRender();
			}
		} else if (this.viewMode === "table" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
			const provider = Array.from(this.visibleTable().providers.keys())[this.selectedIndex];
			if (provider) {
				if (this.expanded.has(provider)) {
					this.expanded.delete(provider);
				} else {
					this.expanded.add(provider);
				}
				this.requestRender();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Render Methods
	// -------------------------------------------------------------------------

	private handleGraphInput(data: string): boolean {
		if (matchesKey(data, "m")) {
			const idx = METRIC_ORDER.indexOf(this.graphMetric);
			this.graphMetric = METRIC_ORDER[(idx + 1) % METRIC_ORDER.length]!;
		} else if (matchesKey(data, "g")) {
			const idx = GROUP_ORDER.indexOf(this.graphGroupBy);
			this.graphGroupBy = GROUP_ORDER[(idx + 1) % GROUP_ORDER.length]!;
			this.graphHidden.clear();
			this.graphLegendIndex = 0;
		} else if (matchesKey(data, "c")) {
			this.graphCumulative = !this.graphCumulative;
		} else if (matchesKey(data, "a")) {
			this.graphHidden.clear();
		} else if (matchesKey(data, "up")) {
			this.graphLegendIndex = Math.max(0, this.graphLegendIndex - 1);
		} else if (matchesKey(data, "down")) {
			const count = this.buildGraphModelForView().series.length;
			this.graphLegendIndex = Math.min(Math.max(count - 1, 0), this.graphLegendIndex + 1);
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			const model = this.buildGraphModelForView();
			const target = model.series[this.graphLegendIndex];
			if (target) {
				if (this.graphHidden.has(target.key)) this.graphHidden.delete(target.key);
				else this.graphHidden.add(target.key);
			}
		} else {
			return false;
		}
		this.requestRender();
		return true;
	}

	private exportCurrentView(): void {
		const now = new Date();
		let name: string;
		let content: string;
		const stats = this.data[this.activeTab];
		if (this.viewMode === "graph") {
			const slice = `${this.graphCumulative ? "cumulative" : "per-bucket"}-${this.graphMetric}-by-${this.graphGroupBy}`;
			name = exportFileName("graph", this.activeTab, slice, "csv", now);
			content = buildGraphCsv(this.buildGraphModelForView());
		} else if (this.viewMode === "insights") {
			name = exportFileName("insights", this.activeTab, null, "json", now);
			content = buildInsightsJson(this.activeTab, stats.totals, stats.insights.insights);
		} else if (this.viewMode === "tasks") {
			name = exportFileName("tasks", this.activeTab, "classified", "csv", now);
			content = buildTaskCsv(this.taskData[this.activeTab]);
		} else {
			const visible = this.visibleTable();
			const sliced = this.tableFilter.trim() !== "" || this.tableHidden.size > 0;
			name = exportFileName("table", this.activeTab, sliced ? "filtered" : null, "csv", now);
			content = buildTableCsv(visible.providers, visible.totals);
		}
		try {
			let configured: string | null = null;
			try {
				configured = parseExportDirSetting(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
			} catch {
				// No settings file or unreadable: fall through to the default dir.
			}
			const home = homedir();
			const dir = resolveExportDir(configured, home, existsSync("/tmp"), tmpdir());
			mkdirSync(dir, { recursive: true });
			const path = join(dir, name);
			writeFileSync(path, content);
			const shown = path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
			this.exportNote = { text: `Saved ${shown}`, ok: true };
		} catch (err) {
			this.exportNote = { text: `Export failed: ${err instanceof Error ? err.message : String(err)}`, ok: false };
		}
	}

	private buildGraphModelForView(): GraphModel {
		return buildGraphModel(this.data.hourly, {
			period: this.activeTab,
			metric: this.graphMetric,
			groupBy: this.graphGroupBy,
			cumulative: this.graphCumulative,
			hidden: this.graphHidden,
			bounds: this.data.bounds,
		});
	}

	render(width: number): string[] {
		if (this.viewMode === "graph") {
			return clampLines(
				[...this.renderTitle(width), ...this.renderTabs(width, getTableLayout(width)), ...this.renderGraph(width), ...this.renderHelp(width)],
				width
			);
		}

		if (this.viewMode === "insights") {
			return clampLines(
				[
					...this.renderTitle(width),
					...this.renderTabs(width, getTableLayout(width)),
					...this.renderInsights(width),
					...this.renderHelp(width),
				],
				width
			);
		}

		const layout = getTableLayout(width);
		if (this.viewMode === "tasks") {
			return clampLines(
				[
					...this.renderTitle(width),
					...this.renderTabs(width, layout),
					...this.renderTaskHeader(layout),
					...this.renderTaskRows(layout),
					...this.renderTaskTotals(layout),
					...this.renderHelp(width),
				],
				width
			);
		}
		return clampLines(
			[
				...this.renderTitle(width),
				...this.renderTabs(width, layout),
				...this.renderHeader(layout),
				...this.renderRows(layout),
				...this.renderTotals(layout),
				...this.renderFormulaNote(width),
				...this.renderHelp(width),
			],
			width
		);
	}

	private renderTitle(width: number): string[] {
		const th = this.theme;
		const title = th.fg("accent", th.bold("Usage"));
		// Render the views as a tab strip (like the period tabs) so it is
		// obvious there are multiple views and [v] switches between them.
		const fullStrip = VIEW_CYCLE.map((view) =>
			view === this.viewMode ? th.fg("accent", `[${VIEW_LABELS[view]}]`) : th.fg("dim", ` ${VIEW_LABELS[view]} `)
		).join(" ");
		const activeOnly = th.fg("accent", `[${VIEW_LABELS[this.viewMode]}]`);
		const line = pickFittingText(width, [
			`${title}   ${fullStrip}  ${th.fg("dim", "[v]")}`,
			`${title}   ${activeOnly}  ${th.fg("dim", "[v]")}`,
			`${title} ${activeOnly}`,
		]);
		return [line, ""];
	}

	private renderGraph(width: number): string[] {
		const th = this.theme;
		const model = this.buildGraphModelForView();
		const lines: string[] = [];

		const modeLabel = `${this.graphCumulative ? "Cumulative" : "Per bucket"} ${METRIC_LABELS[this.graphMetric]} · ${GROUP_LABELS[this.graphGroupBy]}`;
		lines.push(th.fg("muted", modeLabel));
		lines.push("");

		if (model.groupedTotal === 0 && model.series.every((s) => s.total === 0)) {
			lines.push(th.fg("dim", "  No usage data for this period"));
			lines.push("");
			return lines;
		}

		const formatValue = this.graphMetric === "cost" ? formatAxisCost : formatAxisCount;
		const spanMs = model.domainEndMs - model.domainStartMs;
		const formatTime = (ms: number): string => {
			const d = new Date(ms);
			if (spanMs <= 26 * 3_600_000) {
				return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
			}
			return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
		};

		const chartHeight = 12;
		const chart = renderChart(model, {
			width: Math.max(Math.min(width, 110), 30),
			height: chartHeight,
			formatValue,
			formatTime,
			colorize: (seriesIndex, text) => {
				if (seriesIndex < 0) return th.fg("dim", text);
				return seriesColor(seriesIndex) + text + COLOR_RESET;
			},
		});
		lines.push(...chart);
		lines.push("");

		// Legend with selection cursor and hide/show state.
		for (let i = 0; i < model.series.length; i++) {
			const s = model.series[i]!;
			const cursor = i === this.graphLegendIndex ? th.fg("accent", "▸ ") : "  ";
			const marker = s.hidden ? th.fg("dim", "○") : seriesColor(i) + "●" + COLOR_RESET;
			const value = this.graphMetric === "cost" ? formatAxisCost(s.total) : formatAxisCount(s.total);
			const pct =
				s.key !== TOTAL_SERIES_KEY && model.groupedTotal > 0
					? ` ${th.fg("dim", `${Math.round((s.total / model.groupedTotal) * 100)}%`)}`
					: "";
			const label = s.hidden ? th.fg("dim", s.label) : s.key === TOTAL_SERIES_KEY ? th.bold(s.label) : s.label;
			lines.push(`${cursor}${marker} ${padRight(label, 24)} ${padLeft(value, 8)}${pct}`);
		}
		lines.push("");
		return lines;
	}

	private renderInsights(width: number): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];
		const { insights } = stats.insights;
		const hasUsage =
			stats.totals.messages > 0 ||
			stats.totals.cost > 0 ||
			stats.totals.tokens.total > 0 ||
			stats.totals.tokens.cacheRead > 0;
		const hasCost = stats.totals.cost > 0;
		const lines: string[] = [];

		// Cap the content column so advice stays readable on very wide terminals.
		const contentWidth = Math.max(Math.min(width, 100), 40);

		lines.push(th.bold("What's contributing to your cost?"));
		const subtitle = "Approximate, based on local sessions on this machine (these are independent and don't sum to 100%).";
		for (const wrapped of wrapTextWithAnsi(subtitle, contentWidth)) {
			lines.push(th.fg("dim", wrapped));
		}
		lines.push("");

		if (!hasUsage) {
			lines.push(th.fg("dim", "  No usage recorded for this period."));
			lines.push("");
			return lines;
		}
		if (!hasCost) {
			lines.push(th.fg("dim", "  No cost data recorded for this period."));
			lines.push("");
			return lines;
		}
		if (insights.length === 0) {
			lines.push(th.fg("dim", "  Nothing notable for this period."));
			lines.push("");
			return lines;
		}

		// Columns: marker(2) + stat(6) + gap(1); advice aligns under the headline.
		const indent = "         ";
		const adviceWidth = Math.max(contentWidth - indent.length, 30);

		const sectionHeader = (label: string, color: "warning" | "accent"): string => {
			const rule = "─".repeat(Math.max(contentWidth - label.length - 1, 4));
			return `${th.fg(color, th.bold(label))} ${th.fg("border", rule)}`;
		};

		const renderOne = (insight: (typeof insights)[number]): void => {
			const isAlarm = insight.kind === "alarm";
			const marker = isAlarm ? th.fg("warning", "⚠ ") : "  ";
			const statText = padLeft(insight.stat, 6);
			const stat = isAlarm ? th.fg("warning", th.bold(statText)) : th.fg("accent", th.bold(statText));
			// De-emphasise the trailing period-share parenthetical on alarm headlines.
			const match = insight.headline.match(/^(.*?)\s*(\(\d[\d.,]*% of this period\))$/);
			const headline = match ? `${match[1]} ${th.fg("dim", match[2]!)}` : insight.headline;
			lines.push(`${marker}${stat} ${headline}`);
			if (insight.advice) {
				for (const wrapped of wrapTextWithAnsi(insight.advice, adviceWidth)) {
					lines.push(`${indent}${th.fg("dim", wrapped)}`);
				}
			}
			lines.push("");
		};

		const alarms = insights.filter((i) => i.kind === "alarm");
		const structure = insights.filter((i) => i.kind === "structure");
		// Facts first, flagged waste second.
		if (structure.length > 0) {
			lines.push(sectionHeader("Where it went", "accent"));
			for (const insight of structure) renderOne(insight);
		}
		lines.push(sectionHeader("Worth attention", "warning"));
		if (alarms.length > 0) {
			for (const insight of alarms) renderOne(insight);
		} else {
			lines.push(`  ${th.fg("success", padLeft("✓", 6))} ${th.fg("dim", "no waste patterns flagged for this period")}`);
			lines.push("");
		}

		return lines;
	}

	private renderTabs(width: number, layout: TableLayout): string[] {
		const th = this.theme;
		const fullTabs = TAB_ORDER.map((tab) => {
			const label = TAB_LABELS[tab];
			return tab === this.activeTab ? th.fg("accent", `[${label}]`) : th.fg("dim", ` ${label} `);
		}).join("  ");

		const activeTabOnly = th.fg("accent", `[${TAB_LABELS[this.activeTab]}]`);
		const tabLine = pickFittingText(width, [
			fullTabs,
			`${activeTabOnly}  ${th.fg("dim", "[Tab/←→]")}`,
			activeTabOnly,
		]);

		// Compact-note only applies to the table view — it's meaningless for insights.
		const infoLines =
			this.viewMode === "table" && layout.compact
				? wrapTextWithAnsi(th.fg("dim", "Compact view. Widen the terminal for more columns."), Math.max(width, 1))
				: [];

		if (this.viewMode === "table" || this.viewMode === "tasks") {
			const correctionStats = this.correctionData[this.activeTab];
			const coverage = correctionStats.semanticCoverage;
			const lower = correctionStats.totals.assistantTurns > 0
				? correctionStats.totals.corrections / correctionStats.totals.assistantTurns * 100
				: 0;
			infoLines.push(this.theme.fg(
				coverage.sessionPercent >= 0.999 ? "success" : "warning",
				`Semantic coverage ${Math.round(coverage.sessionPercent * 100)}% sessions / ${Math.round(coverage.messagePercent * 100)}% messages · SemCorr = correction + redirect · regex lower bound ${lower.toFixed(2)}%`
			));
		}

		if (this.viewMode === "table") {
			if (this.tableFilterEditing) {
				infoLines.push(`${th.fg("accent", `/ ${this.tableFilter}▌`)}  ${th.fg("dim", "[Enter] keep · [Esc] clear")}`);
			} else if (this.tableFilter.trim() !== "" || this.tableHidden.size > 0) {
				const parts: string[] = [];
				if (this.tableFilter.trim() !== "") parts.push(`filter: “${this.tableFilter.trim()}”`);
				if (this.tableHidden.size > 0) parts.push(`${this.tableHidden.size} hidden`);
				infoLines.push(th.fg("warning", `${parts.join(" · ")}  ·  totals reflect this slice · [a] reset`));
			}
		}

		return [tabLine, ...infoLines, ""];
	}

	private renderTaskHeader(layout: TableLayout): string[] {
		let headerLine = fitCell("Task Type / Model", layout.nameWidth);
		for (const col of layout.columns) {
			const label = fitCell(col.label, col.width, "right");
			headerLine += col.dimmed ? this.theme.fg("dim", label) : label;
		}
		return [
			this.theme.fg("muted", headerLine),
			this.theme.fg("border", "─".repeat(layout.tableWidth)),
			this.theme.fg("dim", "Offline by default · `pi-usage tasks --llm` classifies tasks · `pi-usage corrections --semantic` backfills semantic rework"),
		];
	}

	private renderTaskRows(layout: TableLayout): string[] {
		const visible = this.visibleTaskTypes();
		if (visible.length === 0) return [this.theme.fg("dim", "  No model-attributed usage for this period")];
		const lines: string[] = [];
		for (let index = 0; index < visible.length; index++) {
			const [taskType, stats] = visible[index]!;
			const expanded = this.expandedTasks.has(taskType);
			const arrow = expanded ? "▾" : "▸";
			const prefix = index === this.taskSelectedIndex
				? this.theme.fg("accent", `${arrow} `)
				: this.theme.fg("dim", `${arrow} `);
			lines.push(this.renderDataRow(taskType, this.withLenses(stats, { taskType }), layout, {
				selected: index === this.taskSelectedIndex,
				prefix,
			}));
			if (expanded) {
				for (const model of Array.from(stats.models.values()).sort((a, b) => b.cost - a.cost)) {
					lines.push(this.renderDataRow(
						`${model.provider}/${model.model}`,
						this.withLenses(model, { taskType, provider: model.provider, model: model.model }),
						layout,
						{ indent: 4, dimAll: true }
					));
				}
			}
		}
		return lines;
	}

	private renderTaskTotals(layout: TableLayout): string[] {
		const totals = this.withLenses(this.taskData[this.activeTab].totals);
		let totalRow = fitCell(this.theme.bold("Total"), layout.nameWidth);
		for (const col of layout.columns) {
			const value = fitCell(col.getValue(totals), col.width, "right");
			totalRow += col.dimmed ? this.theme.fg("dim", value) : value;
		}
		return [this.theme.fg("border", "─".repeat(layout.tableWidth)), totalRow, ""];
	}

	private renderHeader(layout: TableLayout): string[] {
		const th = this.theme;

		let headerLine = fitCell("Provider / Model", layout.nameWidth);
		for (const col of layout.columns) {
			const label = fitCell(col.label, col.width, "right");
			headerLine += col.dimmed ? th.fg("dim", label) : label;
		}

		return [th.fg("muted", headerLine), th.fg("border", "─".repeat(layout.tableWidth))];
	}

	private renderDataRow(
		name: string,
		stats: DisplayStats,
		layout: TableLayout,
		options: { indent?: number; selected?: boolean; dimAll?: boolean; prefix?: string } = {}
	): string {
		const th = this.theme;
		const { indent = 0, selected = false, dimAll = false, prefix } = options;

		const rawPrefix = prefix ?? " ".repeat(indent);
		const safePrefix = layout.nameWidth > 0 ? truncateToWidth(rawPrefix, layout.nameWidth, "") : "";
		const prefixWidth = visibleWidth(safePrefix);
		const innerNameWidth = Math.max(layout.nameWidth - prefixWidth, 0);
		const truncName = innerNameWidth > 0 ? truncateToWidth(name, innerNameWidth) : "";
		const styledName = selected ? th.fg("accent", truncName) : dimAll ? th.fg("dim", truncName) : truncName;

		let row = safePrefix + (innerNameWidth > 0 ? padRight(styledName, innerNameWidth) : "");

		for (const col of layout.columns) {
			const value = fitCell(col.getValue(stats), col.width, "right");
			const shouldDim = col.dimmed || dimAll;
			row += shouldDim ? th.fg("dim", value) : value;
		}

		return row;
	}

	private renderRows(layout: TableLayout): string[] {
		const th = this.theme;
		const lines: string[] = [];

		if (this.providerOrder.length === 0) {
			lines.push(th.fg("dim", "  No usage data for this period"));
			return lines;
		}

		const visible = Array.from(this.visibleTable().providers.entries());
		if (visible.length === 0) {
			lines.push(th.fg("dim", "  Nothing matches the current filter — [a] resets"));
			return lines;
		}

		for (let i = 0; i < visible.length; i++) {
			const [providerName, providerStats] = visible[i]!;
			const isSelected = i === this.selectedIndex;
			const isExpanded = this.expanded.has(providerName);
			const arrow = isExpanded ? "▾" : "▸";
			const prefix = isSelected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `);

			const visibleModels = new Set(providerStats.models.keys());
			lines.push(
				this.renderDataRow(
					providerName,
					this.withLenses(providerStats, { provider: providerName, models: visibleModels }),
					layout,
					{ selected: isSelected, prefix }
				)
			);

			if (isExpanded) {
				const models = Array.from(providerStats.models.entries()).sort((a, b) => b[1].cost - a[1].cost);

				for (const [modelName, modelStats] of models) {
					lines.push(this.renderDataRow(
						modelName,
						this.withLenses(modelStats, { provider: providerName, model: modelName }),
						layout,
						{ indent: 4, dimAll: true }
					));
				}
			}
		}

		return lines;
	}

	private renderTotals(layout: TableLayout): string[] {
		const th = this.theme;
		const { totals, providers } = this.visibleTable();
		const visiblePairs = new Set<string>();
		for (const [provider, stats] of providers) {
			for (const model of stats.models.keys()) visiblePairs.add(`${provider}\u0000${model}`);
		}
		const correctedTotals = this.withLenses(totals, { pairs: visiblePairs });

		let totalRow = fitCell(th.bold("Total"), layout.nameWidth);
		for (const col of layout.columns) {
			const value = fitCell(col.getValue(correctedTotals), col.width, "right");
			totalRow += col.dimmed ? th.fg("dim", value) : value;
		}

		return [th.fg("border", "─".repeat(layout.tableWidth)), totalRow, ""];
	}

	private renderFormulaNote(width: number): string[] {
		const line = pickFittingText(width, [
			"Tokens = Input + Output + CacheWrite  ·  ↑In = Input + CacheWrite  (as of 0.2.0)",
			"Tokens = In + Out + CacheWrite  ·  ↑In = In + CacheWrite  (v0.2.0+)",
			"Tokens & ↑In include CacheWrite (v0.2.0+)",
			"Incl. CacheWrite (v0.2.0+)",
		]);
		return [
			this.theme.fg("dim", line),
			this.theme.fg("dim", "Historical Tok/s = output ÷ end-to-end turn wall-clock; TTFT is unavailable."),
			"",
		];
	}

	private renderHelp(width: number): string[] {
		const noteLines = this.exportNote
			? [this.theme.fg(this.exportNote.ok ? "success" : "error", `${this.exportNote.ok ? "✓" : "✗"} ${this.exportNote.text}`), ""]
			: [];
		const variants =
			this.viewMode === "graph"
				? [
						"[Tab/←→] period  [m] metric  [g] group  [c] cumulative  [↑↓/Enter] filter  [a] all  [e] export  [v] view  [q] close",
						"[Tab] period  [m] metric  [g] group  [c] cumul  [↑↓/Enter] filter  [e] export  [v] view  [q] close",
						"[m] metric  [g] group  [c] cumul  [↑↓] filter  [q] close",
						"[m] [g] [c] [↑↓] [q]",
						"[q] close",
				  ]
				: this.viewMode === "insights"
				? [
						"[Tab/←→] period  [e] export  [v] view  [q] close",
						"[Tab] period  [e] export  [v] view  [q] close",
						"[v] view  [q] close",
						"[q] close",
				  ]
				: this.viewMode === "tasks"
				? [
						"[Tab/←→] period  [↑↓] select  [Enter] expand models  [e] export  [v] view  [q] close",
						"[Tab] period  [↑↓/Enter] tasks/models  [e] export  [v] view  [q] close",
						"[↑↓/Enter] tasks  [v] view  [q] close",
						"[q] close",
				  ]
				: [
						"[Tab/←→] period  [↑↓] select  [Enter] expand  [/] filter  [x] hide  [a] all  [e] export  [v] view  [q] close",
						"[Tab] period  [↑↓] select  [Enter] expand  [/] filter  [x] hide  [e] export  [v] view  [q] close",
						"[↑↓] select  [Enter] expand  [/] filter  [x] hide  [v] view  [q] close",
						"[↑↓] select  [/] [x] [v] [q]",
						"[↑↓] select  [q] close",
						"[q] close",
				  ];
		const line = pickFittingText(width, variants);
		return [...noteLines, this.theme.fg("dim", line)];
	}

	invalidate(): void {}
	dispose(): void {}
}

/** pi-tui-only equivalent of Pi's DynamicBorder. */
export class HorizontalBorder implements Component {
	constructor(private readonly color: (text: string) => string) {}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}

	invalidate(): void {}
}

export interface UsageFrame extends Component {
	dispose(): void;
}

/** Build the same bordered dashboard frame for Pi and the standalone CLI. */
export function createUsageFrame(
	theme: UsageTheme,
	data: UsageData,
	requestRender: () => void,
	done: () => void,
	taskData: TaskUsageData,
	correctionData: CorrectionUsageData,
	speedData: SpeedUsageData
): UsageFrame {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new HorizontalBorder((text) => theme.fg("border", text)));
	container.addChild(new Spacer(1));

	const usage = new UsageComponent(theme, data, taskData, correctionData, speedData, requestRender, done);
	return {
		render: (width: number) => {
			const borderLines = clampLines(container.render(width), width);
			const usageLines = usage.render(width);
			const bottomBorder = theme.fg("border", "─".repeat(width));
			return clampLines([...borderLines, ...usageLines, "", bottomBorder], width);
		},
		invalidate: () => {
			container.invalidate();
			usage.invalidate();
		},
		handleInput: (input: string) => usage.handleInput(input),
		dispose: () => usage.dispose(),
	};
}
