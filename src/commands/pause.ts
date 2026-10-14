import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";

export default class PauseCommand extends BaseCommand {
	name = "pause";
	description = "Pause what's playing (resume picks up where it left off)";
	usage = "pause";

	async execute(context: CommandContext): Promise<void> {
		await context.streamingService.pause(context.message);
	}
}
