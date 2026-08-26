#!/usr/bin/env bun

import {
	CancellableLoader,
	matchesKey,
	ProcessTerminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import packageJson from "./package.json" with { type: "json" };
import {
	buildGraphCsv,
	buildGraphModel,
	buildInsightsJson,
	buildTableCsv,
	collectUsageData,
	GROUP_ORDER,
	METRIC_ORDER,
} from "./core/index.ts";
import type {
	GraphGroupBy,
	GraphMetric,
	TabName,
	TimeFilteredStats,
	UsageData,
} from "./core/index.ts";
import { createUsageFrame, formatSinceDate } from "./ui.ts";
import type { UsageTheme, UsageThemeColor } from "./ui.ts";

type Command = "table" | "graph" | "insights";
type OutputFormat = "csv" | "json";

interface CliOptions {
	command: Command;
	format: OutputFormat;
	period: TabName;
	metric: GraphMetric;
	groupBy: GraphGroupBy;
	cumulative: boolean;
}

const PERIOD_ALIASES: Record<string, TabName> = {
	today: "today",
	"this-week": "thisWeek",
	thisweek: "thisWeek",
	"last-week": "lastWeek",
	lastweek: "lastWeek",
	"last-30-days": "last30Days",
	last30days: "last30Days",
	"all-time": "allTime",
	alltime: "allTime",
	all: "allTime",
};

const HELP = `pi-usage ${packageJson.version}

Usage:
  pi-usage                              Open the standalone TUI
  pi-usage [table] [options]            Print per-model CSV (or JSON)
  pi-usage insights [options]           Print structured insights JSON
  pi-usage graph [options]              Print graph-series CSV (or JSON)

Options:
  -p, --period <period>                 today | this-week | last-week | last-30-days | all-time
      --json                            Print JSON (table is the default command)
      --csv                             Print CSV
      --metric <metric>                 cost | tokens | messages | reasoning (graph)
      --group-by <group>                provider | model | thinking | total (graph)
      --per-bucket                      Graph raw buckets instead of cumulative values
      --cumulative                      Graph cumulative values (default)
  -h, --help                            Show help
  -v, --version                         Show version
`;

function fail(message: string): never {
	throw new Error(`${message}\nRun pi-usage --help for usage.`);
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
	const inline = args[index]!.split("=", 2);
	if (inline.length === 2) return [inline[1]!, index];
	const value = args[index + 1];
	if (!value || value.startsWith("-")) fail(`${flag} requires a value`);
	return [value, index + 1];
}

function parsePeriod(value: string): TabName {
	const period = PERIOD_ALIASES[value.toLowerCase()];
	if (!period) fail(`Unknown period: ${value}`);
	return period;
}

function parseArgs(args: string[]): CliOptions | "help" | "version" {
	let command: Command = "table";
	let format: OutputFormat = "csv";
	let period: TabName = "allTime";
	let metric: GraphMetric = "cost";
	let groupBy: GraphGroupBy = "provider";
	let cumulative = true;
	let commandSeen = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-h" || arg === "--help") return "help";
		if (arg === "-v" || arg === "--version") return "version";
		if (arg === "table" || arg === "graph" || arg === "insights") {
			if (commandSeen) fail(`Only one output command may be selected (got ${arg})`);
			command = arg;
			commandSeen = true;
			continue;
		}
		if (arg === "--table" || arg === "--graph" || arg === "--insights") {
			if (commandSeen) fail(`Only one output command may be selected (got ${arg})`);
			command = arg.slice(2) as Command;
			commandSeen = true;
			continue;
		}
		if (arg === "--json") {
			format = "json";
			continue;
		}
		if (arg === "--csv") {
			format = "csv";
			continue;
		}
		if (arg === "-p" || arg === "--period" || arg.startsWith("--period=")) {
			const [value, next] = takeValue(args, i, "--period");
			period = parsePeriod(value);
			i = next;
			continue;
		}
		if (arg === "--metric" || arg.startsWith("--metric=")) {
			const [value, next] = takeValue(args, i, "--metric");
			if (!METRIC_ORDER.includes(value as GraphMetric)) fail(`Unknown graph metric: ${value}`);
			metric = value as GraphMetric;
			i = next;
			continue;
		}
		if (arg === "--group-by" || arg.startsWith("--group-by=")) {
			const [value, next] = takeValue(args, i, "--group-by");
			if (!GROUP_ORDER.includes(value as GraphGroupBy)) fail(`Unknown graph grouping: ${value}`);
			groupBy = value as GraphGroupBy;
			i = next;
			continue;
		}
		if (arg === "--per-bucket") {
			cumulative = false;
			continue;
		}
		if (arg === "--cumulative") {
			cumulative = true;
			continue;
		}
		fail(`Unknown argument: ${arg}`);
	}

	if (command === "insights" && format === "csv") format = "json";
	return { command, format, period, metric, groupBy, cumulative };
}

function serializePeriod(period: TabName, stats: TimeFilteredStats) {
	return {
		period,
		totals: {
			sessions: stats.totals.sessions,
			messages: stats.totals.messages,
			costUsd: stats.totals.cost,
			tokens: stats.totals.tokens,
		},
		providers: Array.from(stats.providers.entries())
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(([provider, providerStats]) => ({
				provider,
				sessions: providerStats.sessions.size,
				messages: providerStats.messages,
				costUsd: providerStats.cost,
				tokens: providerStats.tokens,
				models: Array.from(providerStats.models.entries())
					.sort((a, b) => b[1].cost - a[1].cost)
					.map(([model, modelStats]) => ({
						model,
						sessions: modelStats.sessions.size,
						messages: modelStats.messages,
						costUsd: modelStats.cost,
						tokens: modelStats.tokens,
					})),
			})),
		insights: stats.insights.insights,
	};
}

function printOutput(data: UsageData, options: CliOptions): void {
	const stats = data[options.period];
	if (options.command === "insights") {
		process.stdout.write(buildInsightsJson(options.period, stats.totals, stats.insights.insights));
		return;
	}
	if (options.command === "graph") {
		const model = buildGraphModel(data.hourly, {
			period: options.period,
			metric: options.metric,
			groupBy: options.groupBy,
			cumulative: options.cumulative,
			bounds: data.bounds,
		});
		process.stdout.write(options.format === "json" ? JSON.stringify(model) + "\n" : buildGraphCsv(model));
		return;
	}
	process.stdout.write(
		options.format === "json"
			? JSON.stringify(serializePeriod(options.period, stats)) + "\n"
			: buildTableCsv(stats.providers, stats.totals)
	);
}

const ANSI: Record<UsageThemeColor, string> = {
	accent: "\x1b[96m",
	border: "\x1b[90m",
	success: "\x1b[92m",
	error: "\x1b[91m",
	warning: "\x1b[93m",
	muted: "\x1b[90m",
	dim: "\x1b[2m",
};
const RESET = "\x1b[0m";

function standaloneTheme(): UsageTheme {
	const color = process.env.NO_COLOR === undefined;
	return {
		fg: (name, text) => (color ? ANSI[name] + text + RESET : text),
		bold: (text) => (color ? `\x1b[1m${text}${RESET}` : text),
	};
}

async function runTui(): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		fail("The standalone TUI requires an interactive terminal; use --json, table, graph, or insights when piping output");
	}

	const theme = standaloneTheme();
	const terminal = new ProcessTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	const loader = new CancellableLoader(
		tui,
		(text) => theme.fg("accent", text),
		(text) => theme.fg("muted", text),
		"Loading Usage..."
	);
	let aborted = false;
	let closeDashboard: (() => void) | null = null;
	loader.onAbort = () => {
		aborted = true;
		loader.dispose();
		tui.stop();
	};
	tui.addChild(loader);
	tui.setFocus(loader);
	const removeInputListener = tui.addInputListener((input) => {
		if (matchesKey(input, "ctrl+c")) {
			if (closeDashboard) closeDashboard();
			else loader.handleInput("\x1b");
			return { consume: true };
		}
	});
	tui.start();

	const data = await collectUsageData({
		signal: loader.signal,
		onProgress: (progress) => {
			if (progress.filesToParse === 0) return;
			const files = `${progress.filesParsed.toLocaleString()}/${progress.filesToParse.toLocaleString()} files`;
			if (progress.mode === "update") {
				const since = progress.sinceMs !== null ? ` since ${formatSinceDate(progress.sinceMs)}` : "";
				loader.setMessage(`Updating your usage history${since}… (${files})`);
			} else if (progress.mode === "rebuild") {
				loader.setMessage(`Rebuilding your usage history — the cache format changed… (${files})`);
			} else {
				loader.setMessage(`Building your usage history for the first time… (${files})`);
			}
		},
	});

	if (aborted || !data) {
		removeInputListener();
		if (!aborted) tui.stop();
		return;
	}

	loader.dispose();
	tui.removeChild(loader);
	await new Promise<void>((resolve) => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			frame.dispose();
			removeInputListener();
			tui.stop();
			resolve();
		};
		const frame = createUsageFrame(theme, data, () => tui.requestRender(), finish);
		closeDashboard = finish;
		tui.addChild(frame);
		tui.setFocus(frame);
		tui.requestRender(true);
	});
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		await runTui();
		return;
	}
	const options = parseArgs(args);
	if (options === "help") {
		process.stdout.write(HELP);
		return;
	}
	if (options === "version") {
		process.stdout.write(packageJson.version + "\n");
		return;
	}
	const data = await collectUsageData();
	if (!data) fail("Usage collection was cancelled");
	printOutput(data, options);
}

main().catch((error) => {
	process.stderr.write(`pi-usage: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
