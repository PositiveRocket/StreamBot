import { Message, ActivityOptions } from "discord.js-selfbot-v13";
import config from "../config.js";
import logger from "./logger.js";
import fs from 'fs';

/**
 * Shared utility functions for Discord bot operations
 */
export const DiscordUtils = {
	/**
	 * Create idle status for Discord bot
	 */
	status_idle(): ActivityOptions {
		return {
			name: config.prefix + "help",
			type: 'WATCHING'
		};
	},

	/**
	 * Create watching status for Discord bot
	 */
	status_watch(name: string): ActivityOptions {
		return {
			name: `${name}`,
			type: 'WATCHING'
		};
	},

	/**
	 * Send error message with reaction
	 */
	async sendError(message: Message, error: string): Promise<void> {
		await message.react('❌').catch(() => {});
		await message.reply({ content: `❌ **Error**: ${error}`, allowedMentions: { repliedUser: false } } as any).catch(() => {});
	},

	/**
	 * Send success message with reaction
	 */
	async sendSuccess(message: Message, description: string): Promise<void> {
		await message.react('✅');
		await message.channel.send(`✅ **Success**: ${description}`);
	},

	/**
	 * Send info message with reaction
	 */
	async sendInfo(message: Message, title: string, description: string): Promise<void> {
		await message.react('ℹ️');
		await message.channel.send(`ℹ️ **${title}**: ${description}`);
	},

	/**
	 * Send playing message with reaction
	 */
	async sendPlaying(message: Message, title: string): Promise<void> {
		const content = `📽 **Now Playing**: \`${title}\``;
		await Promise.all([
			message.react('▶️'),
			message.reply(content)
		]);
	},

	/**
	 * Send finish message
	 */
	async sendFinishMessage(message: Message): Promise<void> {
		const content = '⏹️ **Finished**: Finished playing video.';
		await message.channel.send(content);
	},

	/**
	 * Send list message with reaction
	 */
	async sendList(message: Message, items: string[], type?: string): Promise<void> {
		if (type == "ytsearch") {
			await message.reply(`📋 **Search Results**:\n${items.join('\n')}`);
		} else if (type == "refresh") {
			await message.reply(`📋 **Video list refreshed**:\n${items.join('\n')}`);
		} else {
			await message.channel.send(`📋 **Local Videos List**:\n${items.join('\n')}`);
		}
	}
};

/**
 * Quiet feedback: react to the command instead of replying, so the chat isn't flooded.
 * Messages that showed ⏳ ("loading") get it swapped for the final reaction once it starts.
 */
const loading = new WeakSet<object>();
export const Feedback = {
	async react(message: Message | null | undefined, emoji: string): Promise<void> {
		if (!message) return;
		await message.react(emoji).catch(() => {});
	},

	async unreact(message: Message | null | undefined, emoji: string): Promise<void> {
		const me = message?.client?.user?.id;
		if (!message || !me) return;
		try {
			await message.reactions.resolve(emoji)?.users.remove(me);
		} catch {}
	},

	/** Show ⏳ on a command whose video is still loading */
	async loading(message: Message | null | undefined): Promise<void> {
		if (!message) return;
		loading.add(message);
		await Feedback.react(message, '⏳');
	},

	/** The video for this command is now on screen: ⏳ goes away and the command gets its answer */
	async started(message: Message | null | undefined, title?: string): Promise<void> {
		if (!message || !loading.has(message)) return;
		loading.delete(message);
		await Feedback.unreact(message, '⏳');
		if (title) await Feedback.reply(message, `▶️ **Now playing**: \`${title}\``);
	},

	/** The video for this command couldn't start: ⏳ goes away and the command gets an error */
	async failed(message: Message | null | undefined, title?: string): Promise<void> {
		if (!message || !loading.has(message)) return;
		loading.delete(message);
		await Feedback.unreact(message, '⏳');
		if (title) await Feedback.reply(message, `❌ Couldn't play \`${title}\`.`);
	},

	/** Reply without pinging the person who sent the command */
	async reply(message: Message | null | undefined, content: string): Promise<void> {
		if (!message) return;
		await message.reply({ content, allowedMentions: { repliedUser: false } } as any).catch(() => {});
	},
};

/**
 * Error handling utilities
 */
export const ErrorUtils = {
	/**
	 * Handle and log errors consistently
	 */
	async handleError(error: any, context: string, message?: Message): Promise<void> {
		logger.error(`Error in ${context}:`, error);

		if (message) {
			await DiscordUtils.sendError(message, `An error occurred: ${error.message || 'Unknown error'}`);
		}
	},

	/**
	 * Handle async operation errors
	 */
	async withErrorHandling<T>(
		operation: () => Promise<T>,
		context: string,
		message?: Message
	): Promise<T | null> {
		try {
			return await operation();
		} catch (error) {
			await this.handleError(error, context, message);
			return null;
		}
	}
};

/**
 * General utility functions
 */
export const GeneralUtils = {
	/**
	 * Check if input is a valid streaming URL
	 */
	isValidUrl(input: string): boolean {
		if (!input || typeof input !== 'string') {
			return false;
		}

		// Check for common streaming platforms
		return input.includes('youtube.com/') ||
			   input.includes('youtu.be/') ||
			   input.includes('twitch.tv/') ||
			   input.startsWith('http://') ||
			   input.startsWith('https://');
	},

	/**
	 * Check if a path is a local file
	 */
	isLocalFile(filePath: string): boolean {
		try {
			return fs.existsSync(filePath) && fs.lstatSync(filePath).isFile();
		} catch (error) {
			return false;
		}
	}
};