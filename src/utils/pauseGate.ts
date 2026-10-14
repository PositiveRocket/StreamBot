import logger from './logger.js';

/**
 * Freeze-frame pause + stall keep-alive for the streaming library.
 *
 * Every video and audio frame goes through BaseMediaStream._write before it is sent to
 * Discord. We hook that to do two things:
 *
 * 1. Pause: while the gate is closed, frames wait there and ffmpeg is held back by
 *    backpressure. When it opens, each stream re-anchors its clock
 *    (resetTimingCompensation) so playback continues at normal speed from the same spot.
 *
 * 2. Keep-alive: Discord viewers give up on a Go Live stream that stops sending video
 *    ("error 2012 stream failed to start"). That happens while paused, and also when the
 *    source stalls (e.g. the NAS connection hiccups and ffmpeg is reconnecting). So when no
 *    video frame has gone out for a moment, the last keyframe (a complete picture) is resent
 *    a few times a second until real frames flow again.
 */
const AV_PKT_FLAG_KEY = 1;
const STALL_AFTER_MS = 500;        // no new frame for this long = stalled
const KEEPALIVE_EVERY_MS = 200;    // resend the held picture 5 times a second
const GIVE_UP_STALL_MS = 120_000;  // a source dead this long (and not paused) is left to fail normally

let closed = false;
let waiters: (() => void)[] = [];
let currentVideo: any = null;

export const PauseGate = {
	get paused(): boolean {
		return closed;
	},
	pause(): void {
		closed = true;
	},
	/** Open the gate; waiting frames continue */
	resume(): void {
		closed = false;
		const w = waiters;
		waiters = [];
		w.forEach(fn => fn());
	},
	wait(): Promise<void> {
		return closed ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve();
	},
};

function stopWatchdog(stream: any): void {
	if (stream.__watchdog) {
		clearInterval(stream.__watchdog);
		stream.__watchdog = null;
	}
	if (currentVideo === stream) currentVideo = null;
}

/** Resend the last keyframe whenever the video stream goes quiet */
function ensureWatchdog(stream: any): void {
	if (stream.__watchdog) return;
	if (currentVideo && currentVideo !== stream) stopWatchdog(currentVideo); // only the newest stream
	currentVideo = stream;
	stream.__lastSent = Date.now();
	const stop = () => stopWatchdog(stream);
	stream.once('finish', stop);
	stream.once('close', stop);
	stream.once('error', stop);

	stream.__watchdog = setInterval(() => {
		if (currentVideo !== stream || stream.destroyed || stream.writableFinished) return stop();
		const idle = Date.now() - stream.__lastSent;
		if (idle < STALL_AFTER_MS || !stream.__lastKey) return;
		if (!closed && idle > GIVE_UP_STALL_MS) {
			logger.warn(`Video source has been stalled for ${Math.round(idle / 1000)}s, no longer keeping the stream alive`);
			return stop();
		}
		if (!stream.__stalledSince) {
			stream.__stalledSince = stream.__lastSent;
			stream.__stallWasPause = closed;
			if (!closed) logger.warn('Video stalled (waiting on the source), holding the last picture so Discord keeps the stream');
		}
		try {
			Promise.resolve(stream._sendFrame(stream.__lastKey, stream.__frametime || 33)).catch(() => stop());
		} catch {
			stop();
		}
	}, KEEPALIVE_EVERY_MS);
}

/** Hook the gate into the library's frame sender. Safe to call more than once. */
export async function installPauseGate(): Promise<void> {
	try {
		// BaseMediaStream isn't exported, so load the library's own module file directly
		// (same file => same module instance the library uses internally).
		const entry = import.meta.resolve('@dank074/discord-video-stream');
		const mod = await import(new URL('./media/BaseMediaStream.js', entry).href);
		const proto = mod.BaseMediaStream?.prototype;
		if (!proto || proto.__pauseGate) return;

		const originalWrite = proto._write;
		proto._write = async function (this: any, frame: any, encoding: any, callback: any) {
			const isVideo = this.constructor?.name === 'VideoStream';
			if (isVideo && frame?.data) {
				ensureWatchdog(this);
				// Remember the latest complete picture, for keep-alive resends
				if (Number(frame.flags ?? 0) & AV_PKT_FLAG_KEY) {
					this.__lastKey = Buffer.from(frame.data);
					const { duration, timeBase } = frame;
					const ft = timeBase ? (Number(duration) / timeBase.den) * timeBase.num * 1000 : 0;
					if (ft > 0 && isFinite(ft)) this.__frametime = ft;
				}
			}

			if (closed) {
				await PauseGate.wait();
				// Re-anchor timing, otherwise the paused time counts as "behind" and it fast-forwards
				this.resetTimingCompensation();
			}

			const done = (err?: any) => {
				if (isVideo) {
					this.__lastSent = Date.now();
					if (this.__stalledSince) {
						const secs = ((Date.now() - this.__stalledSince) / 1000).toFixed(1);
						if (!this.__stallWasPause) logger.info(`Video resumed after a ${secs}s stall`);
						this.__stalledSince = null;
					}
				}
				callback(err);
			};
			return originalWrite.call(this, frame, encoding, done);
		};
		proto.__pauseGate = true;
		logger.info('Pause and stall keep-alive ready');
	} catch (error) {
		logger.error('Could not set up pause support:', error);
	}
}
