import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";

export default class PauseCommand extends BaseCommand {
	name = "pause";
	description = "Pause what's playing (holds the frame); use it again to resume";
	usage = "pause";
	aliases = ["unpause", "resume"];

	async execute(context: CommandContext): Promise<void> {
		const service = context.streamingService;
		if (service.isPaused()) {
			await service.resume(context.message);
		} else {
			await service.pause(context.message);
		}
	}
}
