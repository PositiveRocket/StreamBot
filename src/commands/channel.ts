import { BaseCommand } from "./base.js";
import { Feedback } from "../utils/shared.js";
import { CommandContext } from "../types/index.js";
import config from "../config.js";

export default class ChannelCommand extends BaseCommand {
	name = "channel";
	description = "Tune into a TV channel (a folder that plays on loop), flip channels, or turn channel mode off";
	usage = "channel [name|number|up|down|off]";
	aliases = ["ch", "tv"];

	async execute(context: CommandContext): Promise<void> {
		const service = context.streamingService;
		const channels = service.getChannelService();
		const arg = context.args.join(' ').trim();
		const lower = arg.toLowerCase();

		// No argument: show the channel guide
		if (!arg || lower === 'list' || lower === 'guide') {
			await this.showGuide(context);
			return;
		}

		if (lower === 'off') {
			const was = service.channelOff();
			if (!was) {
				await this.sendError(context.message, 'No channel is on.');
			} else {
				await Feedback.reply(context.message, `📴 **${was}** turned off. The current video will finish, then the bot stops (\`${config.prefix}stop\` to stop now).`);
			}
			return;
		}

		let target;
		try {
			if (lower === 'up' || lower === 'next' || lower === '+') {
				target = await channels.neighbour(1);
			} else if (lower === 'down' || lower === 'prev' || lower === '-') {
				target = await channels.neighbour(-1);
			} else {
				target = await channels.findChannel(arg);
			}
		} catch (error) {
			await this.sendError(context.message, error instanceof Error ? error.message : String(error));
			return;
		}

		if (!target) {
			await this.sendError(context.message, `No channel matching \`${arg}\`. Use \`${config.prefix}channel\` to see the guide.`);
			return;
		}
		if (target.fileCount === 0) {
			await this.sendError(context.message, `Channel \`${target.name}\` has no videos in it.`);
			return;
		}

		await service.tuneChannel(context.message, target.name, (first: string) =>
			Feedback.reply(context.message, `📺 Tuned to **${target.name}**, starting with \`${first}\``)
		);
	}

	private async showGuide(context: CommandContext): Promise<void> {
		const channels = context.streamingService.getChannelService();
		const current = channels.getCurrent();
		let list;
		try {
			list = await channels.listChannels();
		} catch (error) {
			await this.sendError(context.message, error instanceof Error ? error.message : String(error));
			return;
		}

		if (list.length === 0) {
			const where = channels.describeSource();
			await this.sendError(
				context.message,
				`No channels found in \`${where}\`. Each folder in there is a channel; add a folder (or a link to a show folder) with videos in it.`
			);
			return;
		}

		const lines = list.map((c, i) => {
			const marker = c.name === current ? '▶️' : '▫️';
			return `${marker} **${i + 1}.** ${c.name} — ${c.fileCount} video${c.fileCount === 1 ? '' : 's'}`;
		});
		const p = config.prefix;
		const footer = current
			? `Watching **${current}**. \`${p}ch up\` / \`${p}ch down\` to flip, \`${p}ch off\` to stop after this video.`
			: `\`${p}ch <name or number>\` to tune in.`;

		await context.message.channel.send(`📺 **Channel Guide**\n${lines.join('\n')}\n\n${footer}`);
	}
}
