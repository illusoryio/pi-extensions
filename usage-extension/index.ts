/**
 * /usage - Pi extension wrapper around the shared pi-usage core and UI.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader } from "@earendil-works/pi-tui";

import { collectUsageData } from "./core/data.ts";
import { collectTaskUsageData } from "./core/tasks.ts";
import { collectCorrectionUsageData } from "./core/corrections.ts";
import { collectSpeedUsageData } from "./core/speed.ts";
import type { CollectProgress, UsageData } from "./core/data.ts";
import type { TaskUsageData } from "./core/tasks.ts";
import type { CorrectionUsageData } from "./core/corrections.ts";
import type { SpeedUsageData } from "./core/speed.ts";
import { createUsageFrame, formatSinceDate } from "./ui.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show usage statistics dashboard",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const bundle = await ctx.ui.custom<{ data: UsageData; tasks: TaskUsageData; corrections: CorrectionUsageData; speed: SpeedUsageData } | null>((tui, theme, _kb, done) => {
				const loader = new CancellableLoader(
					tui,
					(text: string) => theme.fg("accent", text),
					(text: string) => theme.fg("muted", text),
					"Loading Usage..."
				);
				let finished = false;
				const finish = (value: { data: UsageData; tasks: TaskUsageData; corrections: CorrectionUsageData; speed: SpeedUsageData } | null) => {
					if (finished) return;
					finished = true;
					loader.dispose();
					done(value);
				};

				loader.onAbort = () => finish(null);
				const onProgress = (progress: CollectProgress): void => {
					if (finished || progress.filesToParse === 0) return;
					const files = `${progress.filesParsed.toLocaleString()}/${progress.filesToParse.toLocaleString()} files`;
					if (progress.mode === "update") {
						const since = progress.sinceMs !== null ? ` since ${formatSinceDate(progress.sinceMs)}` : "";
						loader.setMessage(`Updating your usage history${since}… (${files})`);
					} else if (progress.mode === "rebuild") {
						loader.setMessage(`Rebuilding your usage history — the cache format changed… (${files})`);
					} else {
						loader.setMessage(`Building your usage history for the first time… (${files})`);
					}
				};

				collectUsageData({ signal: loader.signal, onProgress })
					.then(async (data) => {
						if (!data) return null;
						const tasks = await collectTaskUsageData({ usageData: data, signal: loader.signal });
						const corrections = (await collectCorrectionUsageData({ usageData: data, signal: loader.signal })).data;
						const speed = (await collectSpeedUsageData({ usageData: data, signal: loader.signal })).data;
						return { data, tasks, corrections, speed };
					})
					.then(finish)
					.catch(() => finish(null));
				return loader;
			});

			if (!bundle) return;

			await ctx.ui.custom<void>((tui, theme, _kb, done) =>
				createUsageFrame(theme, bundle.data, () => tui.requestRender(), done, bundle.tasks, bundle.corrections, bundle.speed)
			);
		},
	});
}
