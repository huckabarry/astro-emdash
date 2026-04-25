import { fetchWithTimeout } from "./network";

const STATUS_API_BASE_URL = "https://sync.afterword.blog";
const DEFAULT_LIMIT = 20;
const STATUS_CACHE_TTL_MS = 60_000;
const STATUS_FETCH_TIMEOUT_MS = 2_500;

export type StatusFeedImage = {
	thumb: string;
	fullsize: string;
	alt: string;
};

export type StatusFeedExternal = {
	uri: string;
	title: string;
	description: string;
	domain: string;
	thumb: string;
};

export type StatusFeedVideo = {
	playlist: string;
	thumbnail: string;
	alt: string;
	width: number;
	height: number;
};

export type StatusFeedQuotedPost = {
	uri: string;
	blueskyUrl: string;
	displayName: string;
	handle: string;
	avatar: string;
	date: Date;
	text: string;
	html: string;
	images: StatusFeedImage[];
	external: StatusFeedExternal | null;
	video: StatusFeedVideo | null;
};

export type StatusFeedReplyTo = {
	uri: string | null;
	blueskyUrl: string;
	displayName: string;
	handle: string;
};

export type StatusFeedItem = {
	id: string;
	uri: string;
	slug: string;
	text: string;
	html: string;
	date: Date;
	blueskyUrl: string;
	displayName: string;
	handle: string;
	avatar: string;
	isReply: boolean;
	replyCount: number;
	repostCount: number;
	quoteCount: number;
	likeCount: number;
	images: StatusFeedImage[];
	external: StatusFeedExternal | null;
	video: StatusFeedVideo | null;
	quotedPost: StatusFeedQuotedPost | null;
	replyTo: StatusFeedReplyTo | null;
	replies: StatusFeedItem[];
};

export type StatusFeedPage = {
	statuses: StatusFeedItem[];
	cursor: string | null;
	limit: number;
};

type SerializedStatusFeedImage = StatusFeedImage;
type SerializedStatusFeedExternal = StatusFeedExternal;
type SerializedStatusFeedVideo = StatusFeedVideo;

type SerializedStatusFeedQuotedPost = Omit<StatusFeedQuotedPost, "date"> & {
	date: string;
	images: SerializedStatusFeedImage[];
	external: SerializedStatusFeedExternal | null;
	video: SerializedStatusFeedVideo | null;
};

type SerializedStatusFeedReplyTo = StatusFeedReplyTo;

type SerializedStatusFeedItem = Omit<StatusFeedItem, "date" | "quotedPost" | "replyTo" | "replies"> & {
	date: string;
	images: SerializedStatusFeedImage[];
	external: SerializedStatusFeedExternal | null;
	video: SerializedStatusFeedVideo | null;
	quotedPost: SerializedStatusFeedQuotedPost | null;
	replyTo: SerializedStatusFeedReplyTo | null;
	replies: SerializedStatusFeedItem[];
};

type SerializedStatusFeedPage = {
	statuses: SerializedStatusFeedItem[];
	cursor: string | null;
	limit: number;
};

type StatusFeedCacheEntry = {
	expiresAt: number;
	page: StatusFeedPage;
};

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function getStatusApiBaseUrl() {
	return normalizeString(process.env.STATUS_API_URL || process.env.SYNC_SITE_URL || STATUS_API_BASE_URL).replace(
		/\/+$/,
		"",
	);
}

function getStatusPageCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroStatusFeedCache?: Map<string, StatusFeedCacheEntry>;
		__afterwordAstroStatusBySlugCache?: Map<string, { expiresAt: number; post: StatusFeedItem | null }>;
	};

	if (!scope.__afterwordAstroStatusFeedCache) {
		scope.__afterwordAstroStatusFeedCache = new Map();
	}

	if (!scope.__afterwordAstroStatusBySlugCache) {
		scope.__afterwordAstroStatusBySlugCache = new Map();
	}

	return scope;
}

function hydrateQuotedPost(post: SerializedStatusFeedQuotedPost | null): StatusFeedQuotedPost | null {
	if (!post) return null;
	return {
		...post,
		date: new Date(post.date),
	};
}

function hydrateStatusItem(item: SerializedStatusFeedItem): StatusFeedItem {
	return {
		...item,
		date: new Date(item.date),
		quotedPost: hydrateQuotedPost(item.quotedPost),
		replyTo: item.replyTo,
		replies: Array.isArray(item.replies) ? item.replies.map((reply) => hydrateStatusItem(reply)) : [],
	};
}

async function fetchStatusFeedPageFromApi(options?: {
	cursor?: string | null;
	limit?: number;
	includeReplies?: boolean;
}) {
	const limit = Math.max(1, Math.min(Math.floor(options?.limit ?? DEFAULT_LIMIT), 40));
	const cursor = normalizeString(options?.cursor) || null;
	const includeReplies = Boolean(options?.includeReplies);
	const cacheKey = `${limit}:${cursor || "first"}:${includeReplies ? "with-replies" : "no-replies"}`;
	const scope = getStatusPageCache();
	const cached = scope.__afterwordAstroStatusFeedCache?.get(cacheKey);

	if (cached && cached.expiresAt > Date.now()) {
		return cached.page;
	}

	const endpoint = new URL(`${getStatusApiBaseUrl()}/api/status`);
	endpoint.searchParams.set("limit", String(limit));
	if (cursor) endpoint.searchParams.set("cursor", cursor);
	if (includeReplies) endpoint.searchParams.set("includeReplies", "true");

	try {
		const response = await fetchWithTimeout(
			endpoint,
			{ headers: { accept: "application/json" } },
			STATUS_FETCH_TIMEOUT_MS,
		);

		if (!response.ok) {
			throw new Error(`Status API request failed with ${response.status}`);
		}

		const payload = (await response.json()) as SerializedStatusFeedPage;
		const page: StatusFeedPage = {
			statuses: Array.isArray(payload.statuses) ? payload.statuses.map((item) => hydrateStatusItem(item)) : [],
			cursor: normalizeString(payload.cursor) || null,
			limit: Number.isFinite(payload.limit) ? Number(payload.limit) : limit,
		};

		scope.__afterwordAstroStatusFeedCache?.set(cacheKey, {
			expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
			page,
		});

		return page;
	} catch (error) {
		if (cached) {
			console.warn(`[status] Returning stale cached feed page for ${cacheKey}:`, error);
			return cached.page;
		}

		console.warn(`[status] Returning empty feed page for ${cacheKey}:`, error);
		return {
			statuses: [],
			cursor: null,
			limit,
		};
	}
}

export async function getStatusFeedPage(options?: {
	cursor?: string | null;
	limit?: number;
	includeReplies?: boolean;
}) {
	return fetchStatusFeedPageFromApi(options);
}

export async function getStatusBySlug(slug: string) {
	const normalizedSlug = normalizeString(slug);
	if (!normalizedSlug) {
		return null;
	}

	const scope = getStatusPageCache();
	const cached = scope.__afterwordAstroStatusBySlugCache?.get(normalizedSlug);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.post;
	}

	const endpoint = new URL(`${getStatusApiBaseUrl()}/api/status/${encodeURIComponent(normalizedSlug)}`);

	try {
		const response = await fetchWithTimeout(
			endpoint,
			{ headers: { accept: "application/json" } },
			STATUS_FETCH_TIMEOUT_MS,
		);

		if (response.status === 404) {
			scope.__afterwordAstroStatusBySlugCache?.set(normalizedSlug, {
				expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
				post: null,
			});
			return null;
		}

		if (!response.ok) {
			throw new Error(`Status detail API request failed with ${response.status}`);
		}

		const payload = (await response.json()) as { post?: SerializedStatusFeedItem | null };
		const post = payload.post ? hydrateStatusItem(payload.post) : null;
		scope.__afterwordAstroStatusBySlugCache?.set(normalizedSlug, {
			expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
			post,
		});
		return post;
	} catch (error) {
		if (cached) {
			console.warn(`[status] Returning stale cached status post for ${normalizedSlug}:`, error);
			return cached.post;
		}

		console.warn(`[status] Returning empty status post for ${normalizedSlug}:`, error);
		return null;
	}
}
