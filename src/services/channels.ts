import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';

const VIDEO_EXTENSIONS = new Set([
	'.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.wmv', '.ts', '.mpg', '.mpeg'
]);

/** How long a channel's episode list is reused before the folder is read again */
const LISTING_CACHE_MS = 60_000;
/** Safety limit on folder nesting, so a link loop on a network share can't recurse forever */
const MAX_DEPTH = 8;

export interface ChannelInfo {
	name: string;
	/** Folder path (local) or folder URL (network) of the channel */
	location: string;
	fileCount: number;
}

interface Entry {
	name: string;
	location: string;
	isDir: boolean;
}

interface ChannelFile {
	/** File path (local) or URL (network) to hand to the player */
	location: string;
	/** Folder names between the channel folder and the file, e.g. ["SpongeBob", "Season 01"] */
	dirs: string[];
	/** File name without extension */
	name: string;
}

/** Where channel folders are read from: a folder on disk, or a WebDAV server such as rclone */
interface ChannelSource {
	readonly isRemote: boolean;
	readonly root: string;
	list(location: string): Promise<Entry[]>;
	/** Stable identity of a folder, used to detect link loops / the same show linked twice */
	identity(location: string): Promise<string | null>;
	exists(location: string): Promise<boolean>;
}

class LocalSource implements ChannelSource {
	readonly isRemote = false;
	constructor(readonly root: string) {}

	async list(dir: string): Promise<Entry[]> {
		const out: Entry[] = [];
		for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = (await fs.promises.stat(full)).isDirectory();
				} catch {
					logger.debug(`Skipping broken link in channels: ${full}`);
					continue;
				}
			}
			out.push({ name: entry.name, location: full, isDir });
		}
		return out;
	}

	async identity(dir: string): Promise<string | null> {
		try {
			return await fs.promises.realpath(dir);
		} catch {
			return null;
		}
	}

	async exists(file: string): Promise<boolean> {
		return fs.existsSync(file);
	}
}

/**
 * Reads folders over WebDAV. Meant for `rclone serve webdav` in front of an SMB
 * share, so the bot can use a network share without the container mounting anything.
 */
class WebDavSource implements ChannelSource {
	readonly isRemote = true;
	readonly root: string;

	constructor(rootUrl: string) {
		this.root = WebDavSource.asFolder(new URL(rootUrl).toString());
	}

	private static asFolder(url: string): string {
		return url.endsWith('/') ? url : url + '/';
	}

	private static decodeXml(s: string): string {
		return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
			.replace(/&amp;/g, '&');
	}

	private static normalPath(url: string): string {
		return decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
	}

	async list(folderUrl: string): Promise<Entry[]> {
		const url = WebDavSource.asFolder(folderUrl);
		const res = await fetch(url, {
			method: 'PROPFIND',
			headers: { Depth: '1', 'Content-Type': 'application/xml' },
			body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
			signal: AbortSignal.timeout(20_000),
		});
		if (res.status !== 207) {
			throw new Error(`listing ${decodeURIComponent(url)} failed: HTTP ${res.status}`);
		}
		const xml = await res.text();
		const self = WebDavSource.normalPath(url);
		const out: Entry[] = [];

		for (const block of xml.match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/g) || []) {
			const hrefMatch = block.match(/<(?:[\w-]+:)?href>([^<]*)<\/(?:[\w-]+:)?href>/);
			if (!hrefMatch) continue;
			const location = new URL(WebDavSource.decodeXml(hrefMatch[1].trim()), url).toString();
			if (WebDavSource.normalPath(location) === self) continue; // the folder itself

			const isDir = /<(?:[\w-]+:)?collection\b[^>]*\/?>/.test(block);
			const name = WebDavSource.normalPath(location).split('/').pop() || '';
			if (!name) continue;
			out.push({ name, location: isDir ? WebDavSource.asFolder(location) : location, isDir });
		}
		return out;
	}

	async identity(folderUrl: string): Promise<string | null> {
		return WebDavSource.normalPath(folderUrl);
	}

	async exists(): Promise<boolean> {
		// Checking every file over the network isn't worth it: a missing file just fails
		// to play and the channel moves on to the next one.
		return true;
	}
}

export class ChannelSourceError extends Error {}

/**
 * "TV channels": each subfolder of the channels folder is a channel.
 * While a channel is tuned in, the streaming service asks this service for the
 * next file whenever the queue runs dry, so the channel plays forever.
 *
 * The channels folder is either on disk (CHANNELS_DIR) or read over the network
 * from a WebDAV server such as rclone (CHANNELS_URL).
 *
 * Files play in a shuffled order without repeats; once every file has played,
 * the folder is read again (so newly added files get picked up) and reshuffled.
 */
export class ChannelService {
	private source: ChannelSource;
	private current: string | null = null;
	private playlists: Map<string, ChannelFile[]> = new Map();
	private lastPlayed: Map<string, string> = new Map();
	private listingCache: Map<string, { files: ChannelFile[]; at: number }> = new Map();

	constructor() {
		this.source = config.channelsUrl
			? new WebDavSource(config.channelsUrl)
			: new LocalSource(config.channelsDir);
	}

	/** Where channels are read from, for messages */
	public describeSource(): string {
		return this.source.isRemote ? decodeURIComponent(this.source.root) : this.source.root;
	}

	public isRemote(): boolean {
		return this.source.isRemote;
	}

	/** True if this file/URL is a channel episode (so it doesn't need yt-dlp resolving) */
	public isChannelLocation(location: string): boolean {
		if (this.source.isRemote) return location.startsWith(this.source.root);
		return path.resolve(location).startsWith(path.resolve(this.source.root) + path.sep);
	}

	/** Name of the channel currently tuned in, or null if channel mode is off */
	public getCurrent(): string | null {
		return this.current;
	}

	public isActive(): boolean {
		return this.current !== null;
	}

	/** Channel folders (name + location), sorted by name, without counting episodes */
	private async channelFolders(): Promise<{ name: string; location: string }[]> {
		let entries: Entry[];
		try {
			if (!this.source.isRemote && !fs.existsSync(this.source.root)) return [];
			entries = await this.source.list(this.source.root);
		} catch (error: any) {
			logger.error(`Could not read channels from ${this.describeSource()}:`, error);
			throw new ChannelSourceError(
				`Couldn't read the channels folder (${this.describeSource()}): ${error?.message || error}`
			);
		}
		return entries
			.filter(e => e.isDir)
			.map(e => ({ name: e.name, location: e.location }))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	}

	/** List all channels with their episode counts, sorted by name */
	public async listChannels(): Promise<ChannelInfo[]> {
		const folders = await this.channelFolders();
		return Promise.all(folders.map(async f => {
			let fileCount = 0;
			try {
				fileCount = (await this.channelFiles(f.name, f.location)).length;
			} catch (error) {
				logger.warn(`Could not read channel ${f.name}:`, error);
			}
			return { name: f.name, location: f.location, fileCount };
		}));
	}

	/** Find a channel by name (case-insensitive, or the start of a name) or by its 1-based number */
	public async findChannel(query: string): Promise<ChannelInfo | null> {
		const channels = await this.listChannels();
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
	public async neighbour(step: number): Promise<ChannelInfo | null> {
		const channels = (await this.listChannels()).filter(c => c.fileCount > 0);
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

	/** Next file to play on the current channel, or null if it is empty / off / unreachable */
	public async nextFile(): Promise<{ path: string; title: string } | null> {
		const name = this.current;
		if (!name) return null;

		let playlist = this.playlists.get(name);
		if (!playlist || playlist.length === 0) {
			try {
				const folder = (await this.channelFolders()).find(f => f.name === name);
				if (!folder) return null;
				// Fresh read at the start of every pass, so new episodes join the rotation
				this.listingCache.delete(name);
				playlist = this.buildPlaylist(name, await this.channelFiles(name, folder.location));
			} catch (error) {
				logger.error(`Could not read channel ${name}:`, error);
				return null;
			}
			this.playlists.set(name, playlist);
		}

		// Skip files that were deleted since the playlist was built
		while (playlist.length > 0) {
			const file = playlist.shift()!;
			if (await this.source.exists(file.location)) {
				this.lastPlayed.set(name, file.location);
				return { path: file.location, title: this.displayTitle(file, name) };
			}
		}
		return null;
	}

	/**
	 * A readable title for Discord. Bare episode filenames like "S01E01" get the
	 * show's folder name in front: "SpongeBob - S01E01".
	 */
	private displayTitle(file: ChannelFile, channelName: string): string {
		const isSeasonFolder = (d: string) => /^(season|series|s)\s*\d+$|^specials$|^extras$/i.test(d.trim());
		const show = [...file.dirs].reverse().find(d => !isSeasonFolder(d))
			|| (file.dirs.length === 0 ? '' : channelName);
		if (!show || file.name.toLowerCase().includes(show.toLowerCase().replace(/\s*\(\d{4}\)$/, ''))) {
			return file.name;
		}
		return `${show} - ${file.name}`;
	}

	private buildPlaylist(channelName: string, filesIn: ChannelFile[]): ChannelFile[] {
		const files = [...filesIn];
		if (!config.channelShuffle) {
			// Play in order (natural sort, so "Ep 2" comes before "Ep 10")
			const key = (f: ChannelFile) => [...f.dirs, f.name].join('/');
			return files.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
		}

		// Fisher–Yates shuffle
		for (let i = files.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[files[i], files[j]] = [files[j], files[i]];
		}
		// Avoid playing the same file twice in a row across a reshuffle
		const last = this.lastPlayed.get(channelName);
		if (files.length > 1 && files[0].location === last) {
			[files[0], files[files.length - 1]] = [files[files.length - 1], files[0]];
		}
		return files;
	}

	/** Every episode in a channel, cached briefly so the guide doesn't re-read the share each time */
	private async channelFiles(name: string, location: string): Promise<ChannelFile[]> {
		const cached = this.listingCache.get(name);
		if (cached && Date.now() - cached.at < LISTING_CACHE_MS) return cached.files;
		const files = await this.scanFiles(location, [], new Set(), 0);
		this.listingCache.set(name, { files, at: Date.now() });
		return files;
	}

	/**
	 * All video files in a folder, including nested subfolders (e.g. Season 1/, Season 2/).
	 * Links are followed, so a channel can be a folder of links to several shows.
	 */
	private async scanFiles(location: string, dirs: string[], seen: Set<string>, depth: number): Promise<ChannelFile[]> {
		if (depth > MAX_DEPTH) return [];
		const id = await this.source.identity(location);
		if (!id || seen.has(id)) return []; // broken link, link loop, or the same show linked twice
		seen.add(id);

		const out: ChannelFile[] = [];
		const entries = await this.source.list(location);
		for (const entry of entries) {
			if (entry.isDir) {
				// Only the top level throws; a broken subfolder just gets skipped
				try {
					out.push(...await this.scanFiles(entry.location, [...dirs, entry.name], seen, depth + 1));
				} catch (error) {
					logger.warn(`Skipping unreadable folder ${entry.location}:`, error);
				}
			} else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
				out.push({ location: entry.location, dirs, name: path.parse(entry.name).name });
			}
		}
		return out;
	}
}
