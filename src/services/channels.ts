import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';

const VIDEO_EXTENSIONS = new Set([
	'.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.wmv', '.ts', '.mpg', '.mpeg'
]);

export interface ChannelInfo {
	name: string;
	dir: string;
	fileCount: number;
}

/**
 * "TV channels": each subfolder of CHANNELS_DIR is a channel.
 * While a channel is tuned in, the streaming service asks this service for the
 * next file whenever the queue runs dry, so the channel plays forever.
 *
 * Files play in a shuffled order without repeats; once every file has played,
 * the folder is rescanned (so newly added files get picked up) and reshuffled.
 */
export class ChannelService {
	private current: string | null = null;
	private playlists: Map<string, string[]> = new Map();
	private lastPlayed: Map<string, string> = new Map();

	/** Name of the channel currently tuned in, or null if channel mode is off */
	public getCurrent(): string | null {
		return this.current;
	}

	public isActive(): boolean {
		return this.current !== null;
	}

	/** List all channels (subfolders of CHANNELS_DIR), sorted by name */
	public listChannels(): ChannelInfo[] {
		const root = config.channelsDir;
		if (!fs.existsSync(root)) return [];

		return fs.readdirSync(root, { withFileTypes: true })
			.filter(entry => entry.isDirectory() || entry.isSymbolicLink())
			.map(entry => {
				const dir = path.join(root, entry.name);
				let fileCount = 0;
				try {
					fileCount = this.scanFiles(dir).length;
				} catch {
					return null; // broken symlink or unreadable folder
				}
				return { name: entry.name, dir, fileCount };
			})
			.filter((c): c is ChannelInfo => c !== null)
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	}

	/** Find a channel by name (case-insensitive) or by its 1-based number in the list */
	public findChannel(query: string): ChannelInfo | null {
		const channels = this.listChannels();
		const asNumber = parseInt(query, 10);
		if (!isNaN(asNumber) && String(asNumber) === query.trim()) {
			return channels[asNumber - 1] || null;
		}
		const q = query.trim().toLowerCase();
		return channels.find(c => c.name.toLowerCase() === q)
			|| channels.find(c => c.name.toLowerCase().startsWith(q))
			|| null;
	}

	/** Channel N steps away from the current one (wraps around), for "up"/"down" */
	public neighbour(step: number): ChannelInfo | null {
		const channels = this.listChannels().filter(c => c.fileCount > 0);
		if (channels.length === 0) return null;
		const idx = channels.findIndex(c => c.name === this.current);
		const start = idx === -1 ? (step > 0 ? -1 : 0) : idx;
		const next = ((start + step) % channels.length + channels.length) % channels.length;
		return channels[next];
	}

	public tune(name: string): void {
		this.current = name;
		logger.info(`Tuned to channel: ${name}`);
	}

	public off(): void {
		if (this.current) logger.info(`Channel mode off (was: ${this.current})`);
		this.current = null;
	}

	/** Next file to play on the current channel, or null if it is empty / off */
	public nextFile(): { path: string; title: string } | null {
		if (!this.current) return null;
		const channel = this.findChannel(this.current);
		if (!channel) return null;

		let playlist = this.playlists.get(channel.name);
		if (!playlist || playlist.length === 0) {
			playlist = this.buildPlaylist(channel);
			this.playlists.set(channel.name, playlist);
		}

		// Skip files that were deleted since the playlist was built
		while (playlist.length > 0) {
			const file = playlist.shift()!;
			if (fs.existsSync(file)) {
				this.lastPlayed.set(channel.name, file);
				return { path: file, title: this.displayTitle(file, channel.dir) };
			}
		}
		return null;
	}

	/**
	 * A readable title for Discord. Bare episode filenames like "S01E01" get the
	 * show's folder name in front: "The Simpsons (1989) - S01E01".
	 */
	private displayTitle(file: string, channelDir: string): string {
		const name = path.parse(file).name;
		const relDirs = path.relative(channelDir, path.dirname(file)).split(path.sep).filter(Boolean);
		const isSeasonFolder = (d: string) => /^(season|series|s)\s*\d+$|^specials$|^extras$/i.test(d.trim());
		const show = [...relDirs].reverse().find(d => !isSeasonFolder(d))
			|| (relDirs.length === 0 ? '' : path.basename(channelDir));
		if (!show || name.toLowerCase().includes(show.toLowerCase().replace(/\s*\(\d{4}\)$/, ''))) {
			return name;
		}
		return `${show} - ${name}`;
	}

	private buildPlaylist(channel: ChannelInfo): string[] {
		const files = this.scanFiles(channel.dir);
		if (!config.channelShuffle) {
			// Play in order (natural sort, so "Ep 2" comes before "Ep 10")
			return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		}

		// Fisher–Yates shuffle
		for (let i = files.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[files[i], files[j]] = [files[j], files[i]];
		}
		// Avoid playing the same file twice in a row across a reshuffle
		const last = this.lastPlayed.get(channel.name);
		if (files.length > 1 && files[0] === last) {
			[files[0], files[files.length - 1]] = [files[files.length - 1], files[0]];
		}
		return files;
	}

	/**
	 * All video files in a folder, including nested subfolders (e.g. Season 1/, Season 2/).
	 * Symlinks are followed, so a channel can be a folder of links to several shows.
	 */
	private scanFiles(dir: string, seen: Set<string> = new Set()): string[] {
		let real: string;
		try {
			real = fs.realpathSync(dir);
		} catch {
			return []; // broken link
		}
		if (seen.has(real)) return []; // link loop or the same show linked twice
		seen.add(real);

		const out: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = fs.statSync(full).isDirectory();
				} catch {
					logger.debug(`Skipping broken link in channel: ${full}`);
					continue;
				}
			}
			if (isDir) {
				out.push(...this.scanFiles(full, seen));
			} else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
				out.push(full);
			}
		}
		return out;
	}
}
