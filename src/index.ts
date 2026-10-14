import { Client } from "discord.js-selfbot-v13";
import config from "./config.js";
import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import { downloadExecutable, checkForUpdatesAndUpdate } from './utils/yt-dlp.js';

// Import event handlers
import { handleReady } from './events/client/ready.js';
import { handleMessageCreate } from './events/messageCreate.js';
import { handleVoiceStateUpdate } from './events/voiceStateUpdate.js';

// Import services
import { StreamingService } from './services/streaming.js';
import { MediaService } from './services/media.js';
import { CommandManager } from './commands/manager.js';
import { QueueService } from './services/queue.js';
import { installPauseGate } from './utils/pauseGate.js';

// Download yt-dlp and check for updates
(async () => {
	try {
		await downloadExecutable();
		await checkForUpdatesAndUpdate();
	} catch (error) {
		logger.error("Error during initial yt-dlp setup/update:", error);
	}
})();

// Create a new instance of Client
const client = new Client();

// Stream status object
const queueService = new QueueService();
const streamStatus = {
	joined: false,
	joinsucc: false,
	playing: false,
	manualStop: false,
	channelInfo: {
		guildId: config.guildId,
		channelId: config.videoChannelId,
		cmdChannelId: config.cmdChannelId
	},
	queue: queueService.getQueueStatus()
}

// Create services
const streamingService = new StreamingService(client, streamStatus);
const mediaService = new MediaService();
const commandManager = new CommandManager();

// Create the videosFolder dir if it doesn't exist
if (!fs.existsSync(config.videosDir)) {
	fs.mkdirSync(config.videosDir);
}

// Create the channels dir if it doesn't exist (it may live on a read-only mount, so never crash over it)
if (!config.channelsUrl && !fs.existsSync(config.channelsDir)) {
	try {
		fs.mkdirSync(config.channelsDir, { recursive: true });
	} catch (error: any) {
		logger.warn(`Channels folder ${config.channelsDir} does not exist and could not be created (${error.code}). TV channels will be unavailable until it exists.`);
	}
}

// Create previewCache parent dir if it doesn't exist
if (!fs.existsSync(path.dirname(config.previewCacheDir))) {
	fs.mkdirSync(path.dirname(config.previewCacheDir), { recursive: true });
}

// Create the previewCache dir if it doesn't exist
if (!fs.existsSync(config.previewCacheDir)) {
	fs.mkdirSync(config.previewCacheDir);
}

// Get all video files
const videoFiles = fs.readdirSync(config.videosDir);

// Create an array of video objects
let videos = videoFiles.map(file => {
	const fileName = path.parse(file).name;
	return { name: fileName, path: path.join(config.videosDir, file) };
});

// Print available videos
if (videos.length > 0) {
	logger.info(`Available videos:\n${videos.map(m => m.name).join('\n')}`);
}

// Event handlers
client.on("ready", async () => {
	await handleReady(client);
	await autostartChannel();
});

// Start a TV channel on boot if CHANNEL_AUTOSTART is set
async function autostartChannel(): Promise<void> {
	if (!config.channelAutostart) return;
	if (!config.cmdChannelId) {
		logger.warn('CHANNEL_AUTOSTART is set but COMMAND_CHANNEL_ID is empty, so there is nowhere to post updates. Skipping autostart.');
		return;
	}
	try {
		const target = await streamingService.getChannelService().findChannel(config.channelAutostart);
		if (!target) {
			logger.warn(`CHANNEL_AUTOSTART: no channel named "${config.channelAutostart}" in ${config.channelsDir}`);
			return;
		}
		const textChannel: any = await client.channels.fetch(config.cmdChannelId);
		const anchor = await textChannel.send(`📺 **Now tuned to**: \`${target.name}\` (auto-started)`);
		await streamingService.tuneChannel(anchor, target.name);
	} catch (error) {
		logger.error('Failed to autostart channel:', error);
	}
}

client.on('voiceStateUpdate', async (oldState, newState) => {
	await handleVoiceStateUpdate(oldState, newState, streamStatus, client);
});

client.on('messageCreate', async (message) => {
	await handleMessageCreate(message, videos, streamStatus, streamingService, commandManager);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
	if (!(error instanceof Error && error.message.includes('SIGTERM'))) {
		logger.error('Uncaught Exception:', error);
		return
	}
});

// Run server if enabled in config
if (config.server_enabled) {
	// Run server.ts
	import('./server/index.js');
}

// Login to Discord
// Freeze-frame pause support, then log in
await installPauseGate();
client.login(config.token);