import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";
import { formatTime } from "../services/streaming.js";
import config from "../config.js";

export default class StatusCommand extends BaseCommand {
	name = "status";
	description = "Show what's playing, how far in, the channel, and what's up next";
	usage = "status";
	aliases = ["np", "nowplaying"];

	async execute(context: CommandContext): Promise<void> {
		const s = await context.streamingService.getStatus();
		const p = config.prefix;
		const lines: string[] = [];

		if (s.title) {
			lines.push(`${s.paused ? '⏸️ **Paused**' : '▶️ **Now playing**'}: \`${s.title}\``);
			if (s.position !== null) {
				const bar = s.duration ? progressBar(s.position / s.duration) + ' ' : '';
				lines.push(`⏱️ ${bar}${formatTime(s.position)}${s.duration ? ` / ${formatTime(s.duration)}` : ''}`);
			}
		} else {
			lines.push(s.joined ? '⏹️ Nothing is playing right now.' : `⏹️ Nothing is playing. Use \`${p}ch\` or \`${p}play\` to start something.`);
		}

		if (s.channel) {
			const left = s.channelLeft === null ? ''
				: s.channelLeft === 0 ? ' · reshuffles after this episode'
				: ` · ${s.channelLeft} episode${s.channelLeft === 1 ? '' : 's'} left before it reshuffles`;
			lines.push(`📺 **Channel**: ${s.channel}${left}`);
		}

		if (s.upNext.length > 0) {
			const shown = s.upNext.slice(0, 5).map((t, i) => `  ${i + 1}. \`${t}\``);
			if (s.upNext.length > 5) shown.push(`  …and ${s.upNext.length - 5} more`);
			lines.push(`⏭️ **Up next**:\n${shown.join('\n')}`);
		} else if (s.channel) {
			lines.push(`⏭️ **Up next**: another ${s.channel} episode`);
		}

		if (s.paused) lines.push(`Use \`${p}pause\` again to continue.`);

		await context.message.react('📊').catch(() => {});
		await context.message.channel.send(lines.join('\n'));
	}
}

function progressBar(fraction: number, width = 14): string {
	const f = Math.min(1, Math.max(0, fraction));
	const filled = Math.round(f * width);
	return '▬'.repeat(Math.max(0, filled - 1)) + '🔘' + '▬'.repeat(width - Math.max(1, filled));
}
