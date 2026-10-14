import { Client, Message } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import config from "../config.js";
import { MediaService } from './media.js';
import { QueueService } from './queue.js';
import { ChannelService } from './channels.js';
import { getVideoParams } from "../utils/ffmpeg.js";
import logger from '../utils/logger.js';
import { DiscordUtils, ErrorUtils } from '../utils/shared.js';
import { QueueItem, StreamStatus } from '../types/index.js';
import { PauseGate, onLongStall, lastSentPosition, endKeepAlive, retireStreams } from '../utils/pauseGate.js';

interface ResumeInfo {
	/** 'recover' = reopening after the source stalled */
	reason?: 'resume' | 'recover';
	position: number;
	input: string;
	tempFile: string | null;
}

/** Length of a video in seconds (null if it can't be read quickly) */
function probeDuration(input: string): Promise<number | null> {
	const target = input.startsWith('async:') ? input.slice('async:'.length) : input;
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(null), 8000);
		ffmpeg.ffprobe(target, (err: any, data: any) => {
			clearTimeout(timer);
			const d = Number(data?.format?.duration);
			resolve(!err && isFinite(d) && d > 0 ? d : null);
		});
	});
}

export function formatTime(seconds: number): string {
	const s = Math.floor(seconds);
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
	return `${h > 0 ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export class StreamingService {
 	private streamer: Streamer;
 	private mediaService: MediaService;
 	private queueService: QueueService;
 	private controller: AbortController | null = null;
 	private streamStatus: StreamStatus;
 	private failedVideos: Set<string> = new Set();
 	private isSkipping: boolean = false;
 	private channelService: ChannelService = new ChannelService();
 	private currentPlayback: Promise<void> | null = null;
 	private channelFailures: number = 0;
 	private advanceTimer: ReturnType<typeof setTimeout> | null = null;
 	private client: Client;
 	private streamerRawListeners: ((...args: any[]) => void)[] = [];
 	private needsFreshStreamer: boolean = false;
 	// Pause/resume: what is playing right now, and what is paused (if anything)
 	private nowPlaying: { input: string; tempFile: string | null; offset: number; startedAt: number; duration?: number | null; message: Message; itemId?: string } | null = null;
 	private recovering: boolean = false;
 	private keepTempFile: string | null = null;
 	private liveConn: any = null;
 	private recoveries: { itemId: string; count: number; stallAt: number; jumps: number; reopenedAt: number } | null = null;
 	private paused: { item: QueueItem; position: number; at: number } | null = null;
 	// Only one playback may run at a time. Each playback gets a number; a playback that has
 	// been replaced is "stale" and must not advance the queue or tear down the newer stream.
 	private playbackGen: number = 0;
 	private playbackActive: boolean = false;

 	constructor(client: Client, streamStatus: StreamStatus) {
 		this.client = client;
 		this.streamer = this.createStreamer();
 		onLongStall(() => {
 			this.recoverFromStall().catch(err => ErrorUtils.handleError(err, 'recovering from a stall'));
 		});
 		this.mediaService = new MediaService();
 		this.queueService = new QueueService();
 		this.streamStatus = streamStatus;
 	}

	/**
	 * Build a Streamer and remember the gateway listener it adds to the client, so it can be
	 * removed again when the Streamer is replaced.
	 */
	private createStreamer(): Streamer {
		const before = new Set(this.client.listeners('raw'));
		const streamer = new Streamer(this.client);
		this.streamerRawListeners = this.client.listeners('raw').filter(l => !before.has(l)) as any;
		this.liveConn = null;
		if (config.seamlessTransitions) this.makeSeamless(streamer);
		return streamer;
	}

	/**
	 * Seamless episode changes. The library ends the Go Live after every video and starts a new
	 * one for the next, which viewers see as the screen share stopping and restarting. Instead:
	 * - stopStream() from the library (end of a video, skip, channel change) keeps the Go Live open;
	 *   it's only really closed by cleanupStreamStatus, when nothing else is going to play.
	 * - createStream() hands back the open Go Live, and on it, setPacketizer() is not re-run:
	 *   that would restart the RTP sequence numbers mid-stream and viewers' players would drop
	 *   the new video. The numbering just carries on into the next episode.
	 * - "video off" signals between videos are skipped, so viewers aren't told the stream ended.
	 */
	private makeSeamless(streamer: Streamer): void {
		const s: any = streamer;
		const realStop = streamer.stopStream.bind(streamer);
		const realCreate = streamer.createStream.bind(streamer);
		s.realStopStream = () => {
			endKeepAlive();
			this.liveConn = null;
			realStop();
		};
		s.stopStream = () => {
			// keep the Go Live open for the next video
		};
		s.createStream = async () => {
			const open = this.liveConn;
			if (open && open.ready !== false && !open.mediaConnection?._closed && streamer.voiceConnection?.streamConnection) {
				logger.info('Continuing on the open stream (seamless change)');
				return open;
			}
			const conn: any = await realCreate();
			const setPacketizer = conn.setPacketizer.bind(conn);
			conn.setPacketizer = (codec: string) => {
				if (conn._videoPacketizer) return; // already set up: keep the RTP numbering going
				setPacketizer(codec);
			};
			const media = conn.mediaConnection;
			const setVideoAttributes = media.setVideoAttributes.bind(media);
			media.setVideoAttributes = (enabled: boolean, attr?: any) => {
				if (!enabled && this.liveConn === conn) return; // between videos: don't announce "video off"
				setVideoAttributes(enabled, attr);
			};
			this.liveConn = conn;
			return conn;
		};
	}

	/** Really end the Go Live (nothing else is going to play) */
	private stopStreamForReal(): void {
		const s: any = this.streamer;
		if (typeof s.realStopStream === 'function') s.realStopStream();
		else this.streamer.stopStream();
	}

	/**
	 * The voice library keeps internal state between voice sessions, and after leaving voice the
	 * next stream could fail ("Track is not open") even though a fresh start works. So every
	 * time the bot joins voice again after leaving, it gets a brand-new Streamer.
	 */
	private renewStreamer(): void {
		for (const listener of this.streamerRawListeners) this.client.off('raw', listener);
		this.streamer = this.createStreamer();
		this.needsFreshStreamer = false;
		logger.info('Voice connector renewed for a fresh join');
	}

	public getStreamer(): Streamer {
		return this.streamer;
	}

	public getQueueService(): QueueService {
		return this.queueService;
	}

	public getChannelService(): ChannelService {
		return this.channelService;
	}

	/**
	 * Put the next file from the tuned-in channel on the end of the queue.
	 * Returns the queued item, or null if channel mode is off or the channel is empty.
	 */
	private async enqueueFromChannel(): Promise<QueueItem | null> {
		const channel = this.channelService.getCurrent();
		const file = await this.channelService.nextFile();
		if (!channel || !file) return null;
		const type = this.channelService.isRemote() ? 'url' : 'local';
		return this.queueService.add(file.path, `[${channel}] ${file.title}`, `📺 ${channel}`, type, false, file.path);
	}

	/**
	 * Switch to a channel. Whatever is playing is cut off immediately and the
	 * queue is cleared, like flipping the channel on a TV.
	 */
	public async tuneChannel(message: Message, channelName: string): Promise<boolean> {
		this.channelService.tune(channelName);
		this.channelFailures = 0;
		this.cancelPendingAdvance();
		this.clearPaused();

		const wasPlaying = this.playbackActive || this.streamStatus.playing;

		this.queueService.clearQueue();
		const item = await this.enqueueFromChannel();
		if (!item) {
			this.channelService.off();
			await DiscordUtils.sendError(message, `Channel \`${channelName}\` has no videos in it.`);
			if (wasPlaying) {
				await this.stopActivePlayback();
				await this.cleanupStreamStatus();
			}
			return false;
		}

		// Replace whatever is playing (the Go Live stays open, so the channel change is seamless)
		if (wasPlaying) await this.stopActivePlayback();

		this.streamStatus.manualStop = false;
		const next = this.queueService.getNext();
		if (!next) return false;
		this.queueService.setPlaying(true);
		// Don't block the command on the whole video playing
		this.playVideoFromQueueItem(message, next).catch(err =>
			ErrorUtils.handleError(err, 'starting channel playback')
		);
		return true;
	}

	/**
	 * Network channel episodes: reconnect after a dropped connection (but NOT at the end of the
	 * file, which made .mkv episodes hang), and give up on a read that stalls for 30s so a dead
	 * connection fails loudly and the channel moves on instead of freezing silently.
	 */
	private channelInputOptions(input: any): string[] | undefined {
		if (typeof input !== 'string' || !input.startsWith('async:http')) return undefined;
		return [
			'-reconnect 1',
			'-reconnect_streamed 1',
			'-reconnect_on_network_error 1',
			'-reconnect_delay_max 10',
			'-rw_timeout 30000000',
		];
	}

	/** Everything the !status command shows */
	public async getStatus(): Promise<{
		title: string | null; position: number | null; duration: number | null; paused: boolean;
		channel: string | null; channelLeft: number | null; upNext: string[]; joined: boolean;
	}> {
		const item = this.queueService.getCurrent();
		const now = this.nowPlaying;
		const playing = !!(now && item && (this.streamStatus.playing || this.paused));
		let position: number | null = null;
		let duration: number | null = null;
		if (playing && now) {
			position = this.paused ? this.paused.position : now.offset + (Date.now() - now.startedAt) / 1000;
			if (now.duration === undefined) now.duration = await probeDuration(now.input);
			duration = now.duration ?? null;
		}
		const items = this.queueService.getQueue();
		const idx = item ? items.findIndex(i => i.id === item.id) : -1;
		const upNext = items.slice(idx + 1).map(i => `${i.title}${i.requestedBy.startsWith('📺') ? '' : ` (requested by ${i.requestedBy})`}`);
		const channel = this.channelService.getCurrent();
		return {
			title: playing && item ? item.title : null,
			position, duration,
			paused: this.paused !== null,
			channel,
			channelLeft: channel ? this.channelService.remainingInPass(channel) : null,
			upNext,
			joined: this.streamStatus.joined,
		};
	}

	/**
	 * The source has delivered nothing for a while (usually the NAS connection died). Reopen the
	 * same video at the last frame that was shown, which makes a fresh connection. After 3 failed
	 * attempts on the same video, give up on it and move on.
	 */
	private async recoverFromStall(): Promise<void> {
		if (this.recovering || this.paused) return;
		const item = this.queueService.getCurrent();
		const now = this.nowPlaying;
		if (!item || !now || item.isLive || now.itemId !== item.id) return;

		// Where it froze: the last frame actually shown (if the reopened video never showed a frame, where it was reopened)
		const sent = lastSentPosition();
		const stallAt = Math.max(0, now.offset + (sent ?? 0));
		const prev = this.recoveries?.itemId === item.id ? this.recoveries : null;
		const count = (prev?.count ?? 0) + 1;
		// Freezing at the same spot again means a damaged part of the file (a bad spot on the drive),
		// so reopening right there would just freeze again: jump past it instead (10s, then 30s).
		// (also: a reopened video that couldn't get even a few seconds past where it was reopened)
		const sameSpot = !!prev && (Math.abs(stallAt - prev.stallAt) < 8 || stallAt - prev.reopenedAt < 3);
		const jumps = sameSpot ? prev!.jumps + 1 : (prev?.jumps ?? 0);
		const JUMPS = [0, 10, 30];

		this.recovering = true;
		try {
			if (jumps >= JUMPS.length || count > 6) {
				this.recoveries = null;
				logger.warn(`${item.title} keeps stalling, skipping it`);
				await DiscordUtils.sendInfo(now.message, 'Skipping', `\`${item.title}\` keeps freezing, moving on to the next one.`).catch(() => {});
				await this.skipCurrent(now.message);
				return;
			}
			const position = sameSpot ? stallAt + JUMPS[jumps] : Math.max(0, stallAt - 1);
			this.recoveries = { itemId: item.id, count, stallAt, jumps, reopenedAt: position };
			if (sameSpot) {
				logger.warn(`Damaged spot in ${item.url} around ${formatTime(stallAt)}, skipping ahead ${JUMPS[jumps]}s`);
				await DiscordUtils.sendInfo(now.message, 'Damaged spot',
					`\`${item.title}\` can't be read around ${formatTime(stallAt)} (drive problem), skipping ahead ${JUMPS[jumps]}s. This file may need re-downloading.`
				).catch(() => {});
			}
			logger.warn(`Source stalled, reopening ${item.title} at ${formatTime(position)} (attempt ${count})`);
			this.keepTempFile = now.tempFile;
			await this.stopActivePlayback();   // the stalled playback becomes stale: it won't advance the queue
			this.keepTempFile = null;
			this.streamStatus.manualStop = false;
			this.queueService.setCurrentById(item.id);
			this.queueService.setPlaying(true);
			this.playVideoFromQueueItem(now.message, item, { reason: 'recover', position, input: now.input, tempFile: now.tempFile })
				.catch(err => ErrorUtils.handleError(err, 'reopening after a stall'));
		} finally {
			this.recovering = false;
		}
	}

	public isPaused(): boolean {
		return this.paused !== null;
	}

	/**
	 * Pause: hold the current frame. The stream stays live in Discord, but no new frames are sent
	 * (see PauseGate), so viewers see the paused picture until resume continues from the same spot.
	 */
	public async pause(message: Message): Promise<void> {
		if (this.paused) {
			await DiscordUtils.sendError(message, `Already paused. Use \`${config.prefix}pause\` again to continue.`);
			return;
		}
		const item = this.queueService.getCurrent();
		const now = this.nowPlaying;
		if (!this.streamStatus.playing || !item || !now) {
			await DiscordUtils.sendError(message, 'Nothing is playing right now.');
			return;
		}
		if (item.isLive) {
			await DiscordUtils.sendError(message, "Live streams can't be paused.");
			return;
		}

		PauseGate.pause();
		const position = Math.max(0, now.offset + (Date.now() - now.startedAt) / 1000);
		this.paused = { item, position, at: Date.now() };
		this.streamer.client.user?.setActivity(DiscordUtils.status_watch(`⏸ ${item.title}`));
		await DiscordUtils.sendInfo(message, 'Paused', `\`${item.title}\` at ${formatTime(position)}. Use \`${config.prefix}pause\` again to continue.`);
	}

	public async resume(message: Message): Promise<void> {
		const p = this.paused;
		if (!p) {
			await DiscordUtils.sendError(message, 'Nothing is paused.');
			return;
		}
		// Paused time doesn't count towards the playback position
		if (this.nowPlaying) this.nowPlaying.startedAt += Date.now() - p.at;
		this.paused = null;
		PauseGate.resume();
		this.streamer.client.user?.setActivity(DiscordUtils.status_watch(p.item.title));
		await DiscordUtils.sendInfo(message, 'Resumed', `\`${p.item.title}\` from ${formatTime(p.position)}`);
	}

	/** Drop the pause (on stop, skip, channel change or when the video ends) and release held frames */
	private clearPaused(): void {
		this.paused = null;
		if (PauseGate.paused) PauseGate.resume();
	}

	private cancelPendingAdvance(): void {
		if (this.advanceTimer) {
			clearTimeout(this.advanceTimer);
			this.advanceTimer = null;
		}
	}

	/** Leave channel mode. The current video keeps playing; the bot stops after the queue empties. */
	public channelOff(): string | null {
		const was = this.channelService.getCurrent();
		this.channelService.off();
		return was;
	}

	private markVideoAsFailed(videoSource: string): void {
		this.failedVideos.add(videoSource);
		logger.info(`Marked video as failed: ${videoSource}`);
	}

	public async addToQueue(
		message: Message,
		videoSource: string,
		title?: string,
		headers?: Record<string, string>
	): Promise<boolean> {
		try {
			const username = message.author.username;
			const mediaSource = await this.mediaService.resolveMediaSource(videoSource, headers);

			if (mediaSource) {
				const queueItem = await this.queueService.addToQueue(mediaSource, username);
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			} else {
				// Fallback for unresolved sources
				const queueItem = await this.queueService.add(
					videoSource,
					title || videoSource,
					username,
					'url',
					false,
					videoSource,
					headers
				);
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${queueItem.title}\``);
				return true;
			}
		} catch (error) {
			await ErrorUtils.handleError(error, `adding to queue: ${videoSource}`, message);
			return false;
		}
	}


	public async playFromQueue(message: Message): Promise<void> {
		if (this.streamStatus.playing) {
			await DiscordUtils.sendError(message, 'Already playing a video. Use skip command to skip current video.');
			return;
		}

		if (this.paused) {
			await DiscordUtils.sendInfo(message, 'Paused', `Playback is paused. Use \`${config.prefix}pause\` again to continue.`);
			return;
		}

		const nextItem = this.queueService.getNext();
		if (!nextItem) {
			await DiscordUtils.sendError(message, 'Queue is empty.');
			return;
		}

		this.queueService.setPlaying(true);
		await this.playVideoFromQueueItem(message, nextItem);
	}

	public async skipCurrent(message: Message): Promise<void> {
		this.clearPaused();

		if (!this.streamStatus.playing) {
			await DiscordUtils.sendError(message, 'No video is currently playing.');
			return;
		}

		// Check if this is the last item in the queue
		const queueLength = this.queueService.getLength();
		const isLastItem = queueLength <= 1;

		// Prevent concurrent skip operations only if there are more items in queue
		if (this.isSkipping && !isLastItem) {
			await DiscordUtils.sendError(message, 'Skip already in progress.');
			return;
		}

		this.isSkipping = true;

		try {
			// Stop the current video; it's replaced, so it won't advance the queue or close the stream
			const currentItem = this.queueService.getCurrent(); // Get item being skipped
			await this.stopActivePlayback();

			let nextItem = this.queueService.skip(); // Advance the queue
			if (!nextItem && this.channelService.isActive()) {
				await this.enqueueFromChannel();
				nextItem = this.queueService.getNext();
			}

			if (!nextItem) {
				// No more items in queue - stop playback and leave voice channel
				await DiscordUtils.sendInfo(message, 'Queue', 'No more videos in queue.');
				this.queueService.setPlaying(false);
				await this.cleanupStreamStatus();
				return;
			}

			const currentTitle = currentItem ? currentItem.title : 'current video';
			await DiscordUtils.sendInfo(message, 'Skipping', `Skipping \`${currentTitle}\`. Playing next: \`${nextItem.title}\``);

			this.streamStatus.manualStop = false;

			await this.playVideoFromQueueItem(message, nextItem);
		} finally {
			this.isSkipping = false;
		}
	}

	private async playVideoFromQueueItem(message: Message, queueItem: QueueItem, resume?: ResumeInfo): Promise<void> {
		// Ensure queue is marked as playing
		this.queueService.setPlaying(true);

		// Collect video parameters if respect_video_params is enabled
		let videoParams = undefined;
		if (config.respect_video_params) {
			videoParams = await this.getVideoParameters(queueItem.url, queueItem.headers);
		}

		// Log playing video
		logger.info(`Playing from queue: ${queueItem.title} (${queueItem.url})`);

		// Use streaming service to play the video with video parameters
		await this.playVideo(message, queueItem.url, queueItem.title, videoParams, queueItem.headers, resume);
	}

	private async getVideoParameters(videoUrl: string, headers?: Record<string, string>): Promise<{ width: number, height: number, fps?: number, bitrate?: number } | undefined> {
		try {
			const resolution = await getVideoParams(videoUrl, headers);
			logger.info(`Video parameters: ${resolution.width}x${resolution.height}, FPS: ${resolution.fps || 'unknown'}, Bitrate: ${resolution.bitrate || 'unknown'}`);
			
			let bitrateKbps: number | undefined;
			if (resolution.bitrate) {
				bitrateKbps = Math.round(parseInt(resolution.bitrate) / 1000);
			}

			return {
				width: resolution.width,
				height: resolution.height,
				fps: resolution.fps,
				bitrate: bitrateKbps
			};
		} catch (error) {
			await ErrorUtils.handleError(error, 'determining video parameters');
			return undefined;
		}
	}

	private async ensureVoiceConnection(guildId: string, channelId: string, title?: string): Promise<void> {
		// Only join voice if not already connected
		if (!this.streamStatus.joined || !this.streamer.voiceConnection) {
			if (this.needsFreshStreamer) this.renewStreamer();
			await this.streamer.joinVoice(guildId, channelId);
			this.streamStatus.joined = true;
		}
		this.streamStatus.playing = true;
		this.streamStatus.channelInfo = { guildId, channelId, cmdChannelId: config.cmdChannelId! };

		if (title) {
			this.streamer.client.user?.setActivity(DiscordUtils.status_watch(title));
		}

		// Wait for voice connection to be fully ready
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Verify voice connection exists
		if (!this.streamer.voiceConnection) {
			throw new Error('Voice connection is not established');
		}
	}

	private setupStreamConfiguration(videoParams?: { width: number, height: number, fps?: number, bitrate?: number }, headers?: Record<string, string>, inputOptions?: string[]): any {
		let width = videoParams?.width || config.width;
		let height = videoParams?.height || config.height;
		let frameRate = videoParams?.fps || config.fps;
		let bitrateVideo = config.bitrateKbps;

		// If respecting video params, use video bitrate unless overridden
		if (videoParams && videoParams.bitrate && !config.bitrateOverride) {
			bitrateVideo = videoParams.bitrate;
		}

		// Resolution capping
		if (config.maxWidth > 0 || config.maxHeight > 0) {
			const ratio = width / height;
			if (config.maxWidth > 0 && width > config.maxWidth) {
				width = config.maxWidth;
				height = Math.round(width / ratio);
			}
			if (config.maxHeight > 0 && height > config.maxHeight) {
				height = config.maxHeight;
				width = Math.round(height * ratio);
			}
			// Ensure even dimensions
			width = Math.round(width / 2) * 2;
			height = Math.round(height / 2) * 2;
		}

		return {
			width,
			height,
			frameRate,
			bitrateVideo,
			bitrateVideoMax: config.maxBitrateKbps,
			videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
			hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
			minimizeLatency: false,
			h26xPreset: config.h26xPreset,
			// Merged by the library with its default User-Agent/Connection headers
			...(headers && Object.keys(headers).length > 0 && { customHeaders: headers }),
			...(inputOptions && inputOptions.length > 0 && { customInputOptions: inputOptions })
		};
	}

	private async executeStream(inputForFfmpeg: any, streamOpts: any, message: Message, title: string, videoSource: string): Promise<void> {
		const signal = this.controller!.signal;
		const { command, output: ffmpegOutput } = prepareStream(inputForFfmpeg, streamOpts, signal);
		// The library only sends SIGTERM, which ffmpeg can ignore while it's reconnecting. Then the old
		// episode keeps decoding in the background. So also end its output and force-kill it shortly after.
		signal.addEventListener('abort', () => {
			retireStreams();
			try { ffmpegOutput.destroy(); } catch {}
			setTimeout(() => { try { command.kill('SIGKILL'); } catch {} }, 2000);
		}, { once: true });

		command.on("error", (err, stdout, stderr) => {
			// Don't log error if it's due to manual stop
			if (!this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted) {
				logger.error("An error happened with ffmpeg:", err.message);
				if (stdout) {
					logger.error("ffmpeg stdout:", stdout);
				}
				if (stderr) {
					logger.error("ffmpeg stderr:", stderr);
				}
				this.controller.abort();
			}
		});

		if (this.nowPlaying) this.nowPlaying.startedAt = Date.now();
		await playStream(ffmpegOutput, this.streamer, undefined, this.controller!.signal)
			.catch((err) => {
				if (this.controller && !this.controller.signal.aborted) {
					logger.error('playStream error:', err);
					// Send error message to user
					DiscordUtils.sendError(message, `Stream error: ${err.message || 'Unknown error'}`).catch(e =>
						logger.error('Failed to send error message:', e)
					);
				}
				if (this.controller && !this.controller.signal.aborted) this.controller.abort();
			});

		// Only log as finished if we didn't have an error and weren't manually stopped
		if (this.controller && !this.controller.signal.aborted && !this.streamStatus.manualStop) {
			logger.info(`Finished playing: ${title || videoSource}`);
		} else if (this.streamStatus.manualStop) {
			logger.info(`Stopped playing: ${title || videoSource}`);
		} else {
			logger.info(`Failed playing: ${title || videoSource}`);
		}
	}

	private async handleQueueAdvancement(message: Message): Promise<void> {
		if (!this.channelService.isActive()) {
			await DiscordUtils.sendFinishMessage(message);
		}

		// The video finished playing, so remove it from the queue
		const finishedItem = this.queueService.getCurrent();
		if (finishedItem) {
			this.queueService.removeFromQueue(finishedItem.id);
		}

		// Get the next item in the queue. Anything people queued with play goes first,
		// then the channel (if one is tuned in) fills the gap.
		let nextItem = this.queueService.getNext();
		if (!nextItem && this.channelService.isActive()) {
			await this.enqueueFromChannel();
			nextItem = this.queueService.getNext();
		}

		if (nextItem) {
			logger.info(`Auto-playing next item from queue: ${nextItem.title}`);
			this.advanceTimer = setTimeout(() => {
				this.advanceTimer = null;
				this.playVideoFromQueueItem(message, nextItem!).catch(err =>
					ErrorUtils.handleError(err, 'auto-playing next item')
				);
			}, 1000);
		} else {
			// No more items in the queue, so stop playback and clean up
			this.queueService.setPlaying(false);
			logger.info('No more items in queue, playback stopped');
			await this.cleanupStreamStatus();
		}
	}

	private async handleDownload(message: Message, videoSource: string, title?: string): Promise<string | null> {
		const downloadMessage = await message.reply(`📥 Downloading \`${title || 'YouTube video'}\`...`).catch(e => {
			logger.warn("Failed to send 'Downloading...' message:", e);
			return null;
		});

		try {
			logger.info(`Downloading ${title || videoSource}...`);
			const tempFilePath = await this.mediaService.downloadYouTubeVideo(videoSource);

			if (tempFilePath) {
				logger.info(`Finished downloading ${title || videoSource}`);
				if (downloadMessage) {
					await downloadMessage.delete().catch(e => logger.warn("Failed to delete 'Downloading...' message:", e));
				}
				return tempFilePath;
			}
			throw new Error('Download failed, no temp file path returned.');
		} catch (error) {
			logger.error(`Failed to download YouTube video: ${videoSource}`, error);
			const errorMessage = `❌ Failed to download \`${title || 'YouTube video'}\`.`;
			if (downloadMessage) {
				await downloadMessage.edit(errorMessage).catch(e => logger.warn("Failed to edit 'Downloading...' message:", e));
			} else {
				await DiscordUtils.sendError(message, `Failed to download video: ${error instanceof Error ? error.message : String(error)}`);
			}
			return null;
		}
	}

	private async prepareVideoSource(message: Message, videoSource: string, title?: string, headers?: Record<string, string>): Promise<{ inputForFfmpeg: any, tempFilePath: string | null }> {
		// Channel episodes (local files or files on the network share) go straight to ffmpeg, no yt-dlp lookup
		if (this.channelService.isChannelLocation(videoSource)) {
			// Network episodes use ffmpeg's "async:" wrapper. For plain http(s) addresses the streaming
			// library adds -reconnect_at_eof, which makes ffmpeg retry forever when an .mkv ends,
			// freezing the channel. Wrapped, the episode ends cleanly and seeking still works.
			const input = this.channelService.isRemote() ? `async:${videoSource}` : videoSource;
			return { inputForFfmpeg: input, tempFilePath: null };
		}

		const mediaSource = await this.mediaService.resolveMediaSource(videoSource, headers);

		if (mediaSource && mediaSource.type === 'youtube' && !mediaSource.isLive) {
			const tempFilePath = await this.handleDownload(message, videoSource, title);
			if (tempFilePath) {
				return { inputForFfmpeg: tempFilePath, tempFilePath };
			}
			// Download failed, throw to stop playback
			throw new Error('Failed to prepare video source due to download failure.');
		}

		return { inputForFfmpeg: mediaSource ? mediaSource.url : videoSource, tempFilePath: null };
	}

	private async executeStreamWorkflow(input: any, options: any, message: Message, title: string, source: string): Promise<void> {
		this.controller = new AbortController();
		await this.executeStream(input, options, message, title, source);
	}

	private async finalizeStream(message: Message, tempFile: string | null, gen: number): Promise<void> {
		if (gen !== this.playbackGen) {
			// A newer video has taken over: just clean up our own leftovers
			logger.info('Previous video stopped (replaced by a newer one)');
			if (tempFile && tempFile !== this.keepTempFile) {
				try { fs.unlinkSync(tempFile); } catch {}
			}
			return;
		}
		const finishedNormally = !this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted;
		if (finishedNormally) {
			this.channelFailures = 0;
			await this.handleQueueAdvancement(message);
		} else if (!this.streamStatus.manualStop && this.channelService.isActive() && ++this.channelFailures < 5) {
			// A file failed to play while a channel is on: move on to the next one instead of going dark
			logger.warn(`Channel playback failed (${this.channelFailures} in a row), moving on`);
			await this.handleQueueAdvancement(message);
		} else {
			if (this.channelService.isActive() && !this.streamStatus.manualStop) {
				const name = this.channelFailures >= 5 ? this.channelOff() : null;
				if (name) {
					await DiscordUtils.sendError(message, `Channel \`${name}\` turned off after 5 videos in a row failed to play.`).catch(() => {});
				}
			}
			this.channelFailures = 0;
			this.queueService.setPlaying(false);
			this.queueService.resetCurrentIndex();
			await this.cleanupStreamStatus();
		}

		this.nowPlaying = null;
		this.clearPaused();
		if (tempFile) {
			try {
				fs.unlinkSync(tempFile);
			} catch (cleanupError) {
				logger.error(`Failed to delete temp file ${tempFile}:`, cleanupError);
			}
		}
	}

	public async playVideo(message: Message, videoSource: string, title?: string, videoParams?: { width: number, height: number, fps?: number, bitrate?: number }, headers?: Record<string, string>, resume?: ResumeInfo): Promise<void> {
		// Never run two videos at once: stop whatever is still running first, whatever the flags say
		if (this.playbackActive) await this.stopActivePlayback();
		const gen = ++this.playbackGen;
		this.playbackActive = true;
		const playback = this.playVideoInner(message, videoSource, title, videoParams, headers, resume, gen)
			.finally(() => { if (gen === this.playbackGen) this.playbackActive = false; });
		this.currentPlayback = playback;
		return playback;
	}

	/** Stop the running playback (it becomes stale, so it won't advance the queue) and wait for it */
	private async stopActivePlayback(): Promise<void> {
		logger.info('Stopping the previous video before starting the next one');
		this.playbackGen++;
		this.clearPaused();
		this.cancelPendingAdvance();
		this.controller?.abort();
		this.streamer.stopStream();
		if (this.currentPlayback) {
			await Promise.race([
				this.currentPlayback.catch(() => {}),
				new Promise(resolve => setTimeout(resolve, 5000))
			]);
		}
		this.playbackActive = false;
	}

	private async playVideoInner(message: Message, videoSource: string, title?: string, videoParams?: { width: number, height: number, fps?: number, bitrate?: number }, headers?: Record<string, string>, resume?: ResumeInfo, gen: number = this.playbackGen): Promise<void> {
		const [guildId, channelId] = [config.guildId, config.videoChannelId];
		this.streamStatus.manualStop = false;

		if (title) {
			const currentQueueItem = this.queueService.getCurrent();
			if (currentQueueItem?.title === title) {
				this.queueService.setPlaying(true);
			}
		}

		let tempFile: string | null = null;
		try {
			// When resuming, reuse the already-prepared input (e.g. the downloaded YouTube file)
			const { inputForFfmpeg, tempFilePath } = resume
				? { inputForFfmpeg: resume.input, tempFilePath: resume.tempFile }
				: await this.prepareVideoSource(message, videoSource, title, headers);
			tempFile = tempFilePath;
			const offset = resume?.position ?? 0;

			await this.ensureVoiceConnection(guildId, channelId, title);
			if (resume?.reason === 'recover') {
				await DiscordUtils.sendInfo(message, 'Reconnected', `Picked \`${title || videoSource}\` back up at ${formatTime(offset)}`).catch(() => {});
			} else if (resume) {
				await DiscordUtils.sendInfo(message, 'Resumed', `\`${title || videoSource}\` from ${formatTime(offset)}`);
			} else {
				await DiscordUtils.sendPlaying(message, title || videoSource);
			}

			const inputOptions = [
				...(offset > 0 ? [`-ss ${offset.toFixed(1)}`] : []),
				...(this.channelInputOptions(inputForFfmpeg) || []),
			];
			this.nowPlaying = { input: inputForFfmpeg, tempFile, offset, startedAt: Date.now(), message, itemId: this.queueService.getCurrent()?.id };
			const streamOpts = this.setupStreamConfiguration(videoParams, headers, inputOptions);
			await this.executeStreamWorkflow(inputForFfmpeg, streamOpts, message, title || videoSource, videoSource);
		} catch (error) {
			await ErrorUtils.handleError(error, `playing video: ${title || videoSource}`);
			if (this.controller && !this.controller.signal.aborted) this.controller.abort();
			this.markVideoAsFailed(videoSource);
		} finally {
			await this.finalizeStream(message, tempFile, gen);
		}
	}

	public async cleanupStreamStatus(): Promise<void> {
		try {
			this.controller?.abort();
			this.stopStreamForReal();

			// Only leave voice if we're not playing another video
			// Check if there are items in queue that might be played
			const hasQueueItems = !this.queueService.isEmpty();
			if (!hasQueueItems) {
				this.streamer.leaveVoice();
				this.needsFreshStreamer = true;
				this.streamStatus.joined = false;
				this.streamStatus.joinsucc = false;
			}

			this.streamer.client.user?.setActivity(DiscordUtils.status_idle());

			// Reset all status flags
			this.streamStatus.playing = false;
			this.streamStatus.manualStop = false;
			this.streamStatus.channelInfo = {
				guildId: "",
				channelId: "",
				cmdChannelId: "",
			};
		} catch (error) {
			await ErrorUtils.handleError(error, "cleanup stream status");
		}
	}

	public async stopAndClearQueue(): Promise<void> {
		this.channelService.off();
		this.channelFailures = 0;
		this.cancelPendingAdvance();
		this.clearPaused();

		// Clear the queue
		this.queueService.clearQueue();
		logger.info("Queue cleared by stop command");

		// Then cleanup the stream
		await this.cleanupStreamStatus();
	}

}