import { BaseCommand } from "./base.js";
import { CommandContext } from "../types/index.js";

export default class ResumeCommand extends BaseCommand {
	name = "resume";
	description = "Resume a paused video from where it was paused";
	usage = "resume";
	aliases = ["unpause", "continue"];

	async execute(context: CommandContext): Promise<void> {
		await context.streamingService.resume(context.message);
	}
}
