import logger from './logger.js';

/**
 * Freeze-frame pause for the streaming library.
 *
 * Every video and audio frame goes through BaseMediaStream._write before it is sent to
 * Discord. While the gate is closed, frames wait there: nothing new reaches Discord, so
 * viewers keep seeing the last frame, and ffmpeg is held back by backpressure. When the
 * gate opens again, each stream re-anchors its clock (resetTimingCompensation) so playback
 * continues at normal speed from the same spot, instead of fast-forwarding to "catch up".
 */
let closed = false;
let waiters: (() => void)[] = [];

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
			if (closed) {
				await PauseGate.wait();
				// Re-anchor timing, otherwise the paused time counts as "behind" and it fast-forwards
				this.resetTimingCompensation();
			}
			return originalWrite.call(this, frame, encoding, callback);
		};
		proto.__pauseGate = true;
		logger.info('Pause support ready');
	} catch (error) {
		logger.error('Could not set up pause support:', error);
	}
}
