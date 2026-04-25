import { fetchWithTimeout } from "./network";

const MEDIA_API_BASE_URL = "https://sync.afterword.blog";
const MEDIA_CACHE_TTL_MS = 1000 * 60 * 10;
const MEDIA_TIMELINE_PAGE_CACHE_TTL_MS = 1000 * 60;
const MEDIA_FETCH_TIMEOUT_MS = 2_500;

export type MediaTimelineLink = {
	label: string;
	url: string;
	external: boolean;
};

export type AlbumEntry = {
	id: string;
	slug: string;
	title: string;
	albumTitle: string;
	artist: string;
	note: string;
	noteHtml?: string | null;
	excerpt: string;
	coverImage: string | null;
	publishedAt: Date;
	displayDate: string;
	sourceUrl: string;
	localPath: string;
	listenLinks: { label: string; url: string }[];
};

export type TrackEntry = {
	id: string;
	slug: string;
	title: string;
	trackTitle: string;
	artist: string;
	note: string;
	noteHtml?: string | null;
	excerpt: string;
	artworkUrl: string | null;
	publishedAt: Date;
	displayDate: string;
	sourceUrl: string;
	localPath: string;
	appleMusicUrl: string | null;
	playlistUrl: string | null;
	songlinkUrl: string | null;
	previewUrl: string | null;
	listenLinks: { label: string; url: string }[];
};

type SerializedAlbumEntry = Omit<AlbumEntry, "publishedAt"> & {
	publishedAt: string;
};

type SerializedTrackEntry = Omit<TrackEntry, "publishedAt"> & {
	publishedAt: string;
};

export type PopfeedItemType = "book" | "movie" | "tv_show";

export type PopfeedItem = {
	id: string;
	uri: string;
	cid: string;
	slug: string;
	type: PopfeedItemType;
	section: "books" | "movies" | "shows";
	sectionLabel: "Books" | "Movies" | "Shows";
	localPath: string;
	title: string;
	mainCredit: string;
	mainCreditRole: string;
	genres: string[];
	listUri: string;
	listName: string;
	listDescription: string;
	listType: string;
	listTypeLabel: string;
	activityLabel: string;
	activityDateLabel: string;
	addedAt: Date | null;
	activityAt: Date | null;
	startedAt: Date | null;
	completedAt: Date | null;
	releaseDate: Date | null;
	date: Date;
	displayDate: string;
	activityDisplayDate: string | null;
	posterImage: string | null;
	sourcePosterImage: string | null;
	backdropUrl: string | null;
	identifiers: Record<string, string>;
	links: { label: string; url: string }[];
};

type SerializedPopfeedItem = Omit<
	PopfeedItem,
	"addedAt" | "activityAt" | "startedAt" | "completedAt" | "releaseDate" | "date"
> & {
	addedAt: string | null;
	activityAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	releaseDate: string | null;
	date: string;
};

export type MediaTimelineItem = {
	id: string;
	kind: "track" | "album" | "popfeed";
	label: string;
	title: string;
	href: string;
	dateIso: string;
	dateLabel: string;
	summary: string;
	imageUrl: string | null;
	imageAlt: string | null;
	tags: string[];
	artist?: string;
	audioUrl?: string | null;
	credit?: string;
	links: MediaTimelineLink[];
	mediaType?: string;
	statusLabel?: string;
	activityLabel?: string;
};

type MediaTimelineFilterKind = MediaTimelineItem["kind"];

type MediaTimelinePageResponse = {
	items: MediaTimelineItem[];
	offset: number;
	limit: number;
	total: number;
	nextOffset: number | null;
	generatedAt?: string | null;
	filters?: {
		kinds?: MediaTimelineFilterKind[];
		mediaTypes?: PopfeedItemType[];
	};
};

type MediaCollectionResponse<T> = {
	items?: T[];
};

type MediaState = {
	expiresAt: number;
	albums: AlbumEntry[];
	tracks: TrackEntry[];
	popfeed: PopfeedItem[];
	timeline: MediaTimelineItem[];
};

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function normalizeOptionalDate(value: string | null | undefined) {
	const normalized = normalizeString(value);
	if (!normalized) return null;
	const parsed = new Date(normalized);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getMediaApiBaseUrl() {
	return normalizeString(process.env.MEDIA_API_URL || process.env.SYNC_SITE_URL || MEDIA_API_BASE_URL)
		.replace(/\/+$/, "")
		.replace(/\/media\/timeline\.json$/i, "");
}

function resolveSyncMediaUrl(value: string | null | undefined) {
	const normalized = normalizeString(value);
	if (!normalized) return null;
	if (!normalized.startsWith("/")) return normalized;
	return `${getMediaApiBaseUrl()}${normalized}`;
}

function hydrateAlbumEntry(entry: SerializedAlbumEntry): AlbumEntry {
	return {
		...entry,
		coverImage: resolveSyncMediaUrl(entry.coverImage),
		publishedAt: new Date(entry.publishedAt),
	};
}

function hydrateTrackEntry(entry: SerializedTrackEntry): TrackEntry {
	return {
		...entry,
		artworkUrl: resolveSyncMediaUrl(entry.artworkUrl),
		publishedAt: new Date(entry.publishedAt),
	};
}

function hydratePopfeedItem(item: SerializedPopfeedItem): PopfeedItem {
	return {
		...item,
		addedAt: normalizeOptionalDate(item.addedAt),
		activityAt: normalizeOptionalDate(item.activityAt),
		startedAt: normalizeOptionalDate(item.startedAt),
		completedAt: normalizeOptionalDate(item.completedAt),
		releaseDate: normalizeOptionalDate(item.releaseDate),
		date: new Date(item.date),
		posterImage: resolveSyncMediaUrl(item.posterImage),
		sourcePosterImage: resolveSyncMediaUrl(item.sourcePosterImage),
		backdropUrl: resolveSyncMediaUrl(item.backdropUrl),
	};
}

function getCacheScope() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroMediaCache?: MediaState | null;
		__afterwordAstroMediaPromise?: Promise<MediaState> | null;
		__afterwordAstroLatestTrackCache?: {
			expiresAt: number;
			item: MediaTimelineItem | null;
		} | null;
		__afterwordAstroLatestTrackPromise?: Promise<MediaTimelineItem | null> | null;
		__afterwordAstroMediaTimelinePageCache?: Map<
			string,
			{ expiresAt: number; page: MediaTimelinePageResponse }
		>;
		__afterwordAstroMediaTimelinePagePromises?: Map<string, Promise<MediaTimelinePageResponse>>;
	};

	if (!("__afterwordAstroMediaCache" in scope)) {
		scope.__afterwordAstroMediaCache = null;
		scope.__afterwordAstroMediaPromise = null;
		scope.__afterwordAstroLatestTrackCache = null;
		scope.__afterwordAstroLatestTrackPromise = null;
	}

	if (!scope.__afterwordAstroMediaTimelinePageCache) {
		scope.__afterwordAstroMediaTimelinePageCache = new Map();
	}

	if (!scope.__afterwordAstroMediaTimelinePagePromises) {
		scope.__afterwordAstroMediaTimelinePagePromises = new Map();
	}

	return scope;
}

function buildMediaTimelinePageCacheKey({
	offset,
	limit,
	kind,
	mediaType,
}: {
	offset: number;
	limit: number;
	kind?: MediaTimelineFilterKind | null;
	mediaType?: PopfeedItemType | null;
}) {
	return JSON.stringify({
		offset,
		limit,
		kind: kind || null,
		mediaType: mediaType || null,
	});
}

function toTrackTimelineItem(track: TrackEntry): MediaTimelineItem {
	return {
		id: `track-${track.slug}`,
		kind: "track",
		label: "Listening",
		title: track.trackTitle,
		href: track.localPath,
		dateIso: track.publishedAt.toISOString(),
		dateLabel: track.displayDate,
		summary: track.note || "",
		imageUrl: track.artworkUrl || null,
		imageAlt: `${track.trackTitle} by ${track.artist}`,
		tags: [],
		artist: track.artist,
		audioUrl: track.previewUrl || null,
		links: (track.listenLinks || []).slice(0, 3).map((link) => ({
			label: link.label,
			url: link.url,
			external: true,
		})),
	};
}

function toAlbumTimelineItem(album: AlbumEntry): MediaTimelineItem {
	return {
		id: `album-${album.slug}`,
		kind: "album",
		label: "Album Rotation",
		title: album.albumTitle,
		href: album.localPath,
		dateIso: album.publishedAt.toISOString(),
		dateLabel: album.displayDate,
		summary: album.note || "",
		imageUrl: album.coverImage || null,
		imageAlt: `${album.albumTitle} by ${album.artist}`,
		tags: [],
		artist: album.artist,
		links: (album.listenLinks || []).slice(0, 3).map((link) => ({
			label: link.label,
			url: link.url,
			external: true,
		})),
	};
}

function toPopfeedTimelineItem(item: PopfeedItem): MediaTimelineItem {
	return {
		id: `popfeed-${item.type}-${item.slug}`,
		kind: "popfeed",
		label: item.sectionLabel.slice(0, -1) || item.sectionLabel,
		title: item.title,
		href: item.localPath,
		dateIso: item.date.toISOString(),
		dateLabel: item.displayDate,
		summary: item.genres.slice(0, 4).join(", "),
		imageUrl: item.posterImage,
		imageAlt: item.mainCredit ? `${item.title} by ${item.mainCredit}` : item.title,
		tags: item.listTypeLabel ? [item.listTypeLabel] : [],
		credit: item.mainCredit,
		links: (item.links || []).slice(0, 3).map((link) => ({
			label: link.label,
			url: link.url,
			external: true,
		})),
		mediaType: item.type,
		statusLabel: item.listTypeLabel,
		activityLabel: item.activityLabel,
	};
}

async function fetchMediaTimelinePageFromApi({
	offset,
	limit,
	kind,
	mediaType,
}: {
	offset: number;
	limit: number;
	kind?: MediaTimelineFilterKind | null;
	mediaType?: PopfeedItemType | null;
}) {
	const normalizedOffset = Math.max(0, Math.floor(offset));
	const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 40));
	const cacheKey = buildMediaTimelinePageCacheKey({
		offset: normalizedOffset,
		limit: normalizedLimit,
		kind,
		mediaType,
	});
	const scope = getCacheScope();
	const cached = scope.__afterwordAstroMediaTimelinePageCache?.get(cacheKey);

	if (cached && cached.expiresAt > Date.now()) {
		return cached.page;
	}

	const pending = scope.__afterwordAstroMediaTimelinePagePromises?.get(cacheKey);
	if (pending) {
		return pending;
	}

	const request = (async () => {
		const endpoint = new URL(`${getMediaApiBaseUrl()}/media/timeline.json`);
		endpoint.searchParams.set("offset", String(normalizedOffset));
		endpoint.searchParams.set("limit", String(normalizedLimit));
		if (kind) endpoint.searchParams.set("kind", kind);
		if (mediaType) endpoint.searchParams.set("mediaType", mediaType);

		const response = await fetchWithTimeout(
			endpoint,
			{ headers: { accept: "application/json" } },
			MEDIA_FETCH_TIMEOUT_MS,
		);

		if (!response.ok) {
			throw new Error(`Unable to fetch remote media timeline: ${response.status}`);
		}

		const payload = (await response.json()) as Partial<MediaTimelinePageResponse>;
		const page: MediaTimelinePageResponse = {
			items: Array.isArray(payload.items)
				? (payload.items as MediaTimelineItem[]).map((item) => ({
						...item,
						imageUrl: resolveSyncMediaUrl(item.imageUrl),
				  }))
				: [],
			offset: Number.isFinite(payload.offset) ? Number(payload.offset) : normalizedOffset,
			limit: Number.isFinite(payload.limit) ? Number(payload.limit) : normalizedLimit,
			total: Number.isFinite(payload.total) ? Number(payload.total) : 0,
			nextOffset:
				payload.nextOffset === null || Number.isFinite(payload.nextOffset)
					? (payload.nextOffset as number | null)
					: null,
			generatedAt: normalizeString(payload.generatedAt) || null,
			filters: payload.filters,
		};

		scope.__afterwordAstroMediaTimelinePageCache?.set(cacheKey, {
			expiresAt: Date.now() + MEDIA_TIMELINE_PAGE_CACHE_TTL_MS,
			page,
		});

		return page;
	})().finally(() => {
		scope.__afterwordAstroMediaTimelinePagePromises?.delete(cacheKey);
	});

	scope.__afterwordAstroMediaTimelinePagePromises?.set(cacheKey, request);
	return request;
}

async function fetchMediaCollectionFromApi<T>(path: string) {
	const endpoint = new URL(`${getMediaApiBaseUrl()}${path}`);
	const response = await fetchWithTimeout(
		endpoint,
		{ headers: { accept: "application/json" } },
		MEDIA_FETCH_TIMEOUT_MS,
	);

	if (!response.ok) {
		throw new Error(`Unable to fetch remote media collection ${path}: ${response.status}`);
	}

	const payload = (await response.json()) as MediaCollectionResponse<T>;
	return Array.isArray(payload.items) ? payload.items : [];
}

async function fetchAlbumsFromApi() {
	return (await fetchMediaCollectionFromApi<SerializedAlbumEntry>("/api/media/albums")).map(hydrateAlbumEntry);
}

async function fetchTracksFromApi() {
	return (await fetchMediaCollectionFromApi<SerializedTrackEntry>("/api/media/tracks")).map(hydrateTrackEntry);
}

async function fetchPopfeedItemsFromApi() {
	return (await fetchMediaCollectionFromApi<SerializedPopfeedItem>("/api/media/popfeed")).map(
		hydratePopfeedItem,
	);
}

async function fetchMediaState() {
	const scope = getCacheScope();
	const cached = scope.__afterwordAstroMediaCache;
	if (cached && cached.expiresAt > Date.now()) {
		return cached;
	}

	if (scope.__afterwordAstroMediaPromise) {
		return scope.__afterwordAstroMediaPromise;
	}

	const request = Promise.all([fetchAlbumsFromApi(), fetchTracksFromApi(), fetchPopfeedItemsFromApi()])
		.then(([albums, tracks, popfeed]) => {
			const timeline = [
				...tracks.map(toTrackTimelineItem),
				...albums.map(toAlbumTimelineItem),
				...popfeed.map(toPopfeedTimelineItem),
			].sort((left, right) => Date.parse(right.dateIso) - Date.parse(left.dateIso));

			const state: MediaState = {
				expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
				albums,
				tracks,
				popfeed,
				timeline,
			};

			scope.__afterwordAstroMediaCache = state;
			return state;
		})
		.finally(() => {
			scope.__afterwordAstroMediaPromise = null;
		});

	scope.__afterwordAstroMediaPromise = request;

	try {
		return await request;
	} catch (error) {
		if (cached) {
			console.warn("[media] Returning stale cached media state after API failure:", error);
			return cached;
		}

		console.warn("[media] Returning empty media state after API failure:", error);
		return {
			expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
			albums: [],
			tracks: [],
			popfeed: [],
			timeline: [],
		} satisfies MediaState;
	}
}

export async function getAlbums() {
	return (await fetchMediaState()).albums;
}

export async function getAlbumBySlug(slug: string) {
	return (await getAlbums()).find((album) => album.slug === slug) || null;
}

export async function getTracks() {
	return (await fetchMediaState()).tracks;
}

export async function getLatestTrack() {
	const scope = getCacheScope();
	const cachedState = scope.__afterwordAstroMediaCache;
	if (cachedState && cachedState.expiresAt > Date.now()) {
		return cachedState.timeline.find((item) => item.kind === "track") || null;
	}

	if (scope.__afterwordAstroLatestTrackCache && scope.__afterwordAstroLatestTrackCache.expiresAt > Date.now()) {
		return scope.__afterwordAstroLatestTrackCache.item;
	}

	if (!scope.__afterwordAstroLatestTrackPromise) {
		scope.__afterwordAstroLatestTrackPromise = fetchMediaTimelinePageFromApi({
			offset: 0,
			limit: 1,
			kind: "track",
		})
			.then((page) => {
				const item = page.items[0] || null;
				scope.__afterwordAstroLatestTrackCache = {
					expiresAt: Date.now() + MEDIA_TIMELINE_PAGE_CACHE_TTL_MS,
					item,
				};
				return item;
			})
			.catch(async (error) => {
				const state = await fetchMediaState();
				const item = state.timeline.find((entry) => entry.kind === "track") || null;
				scope.__afterwordAstroLatestTrackCache = {
					expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
					item,
				};
				if (!item) {
					console.warn("[media] Returning empty latest track after API failure:", error);
				}
				return item;
			})
			.finally(() => {
				scope.__afterwordAstroLatestTrackPromise = null;
			});
	}

	return scope.__afterwordAstroLatestTrackPromise;
}

export async function getTrackBySlug(slug: string) {
	return (await getTracks()).find((track) => track.slug === slug) || null;
}

export async function getPopfeedItems() {
	return (await fetchMediaState()).popfeed;
}

export async function getPopfeedItemsByType(type: PopfeedItemType) {
	return (await getPopfeedItems()).filter((item) => item.type === type);
}

export async function getPopfeedItemBySlug(type: PopfeedItemType, slug: string) {
	return (await getPopfeedItemsByType(type)).find((item) => item.slug === slug) || null;
}

export async function getMediaTimeline(limit = 24) {
	const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 60));

	try {
		return (await fetchMediaTimelinePageFromApi({ offset: 0, limit: normalizedLimit })).items;
	} catch (error) {
		const state = await fetchMediaState();
		if (!state.timeline.length) {
			console.warn("[media] Returning empty media timeline after API failure:", error);
		}
		return state.timeline.slice(0, normalizedLimit);
	}
}

export async function getMediaTimelinePage(offset = 0, limit = 24) {
	const normalizedOffset = Math.max(0, Math.floor(offset));
	const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 40));

	try {
		const page = await fetchMediaTimelinePageFromApi({
			offset: normalizedOffset,
			limit: normalizedLimit,
		});

		return {
			items: page.items,
			offset: page.offset,
			limit: page.limit,
			total: page.total,
			nextOffset: page.nextOffset,
		};
	} catch (error) {
		const state = await fetchMediaState();
		const items = state.timeline.slice(normalizedOffset, normalizedOffset + normalizedLimit);
		const nextOffset =
			normalizedOffset + normalizedLimit < state.timeline.length
				? normalizedOffset + normalizedLimit
				: null;

		if (!items.length) {
			console.warn("[media] Returning empty media timeline page after API failure:", error);
		}

		return {
			items,
			offset: normalizedOffset,
			limit: normalizedLimit,
			total: state.timeline.length,
			nextOffset,
		};
	}
}
