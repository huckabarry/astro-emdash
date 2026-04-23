import { fetchWithTimeout } from "./network";

const AUTHOR_FEED_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";
const THREAD_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread";
const DEFAULT_REPO = "did:plc:vt4k6d3e5rjw65cuzaf3nufq";
const DEFAULT_LIMIT = 20;
const STATUS_LOOKUP_PAGE_LIMIT = 40;
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

type StatusFeedCacheEntry = {
	expiresAt: number;
	page: StatusFeedPage;
};

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function normalizeImage(value: Record<string, unknown>): StatusFeedImage {
	return {
		thumb: normalizeString(value.thumb),
		fullsize: normalizeString(value.fullsize) || normalizeString(value.thumb),
		alt: normalizeString(value.alt),
	};
}

function normalizeExternal(value: Record<string, unknown> | null | undefined) {
	if (!value) {
		return null;
	}

	const uri = normalizeString(value.uri);
	if (!uri) {
		return null;
	}

	return {
		uri,
		title: normalizeString(value.title),
		description: normalizeString(value.description),
		domain: normalizeString(value.domain),
		thumb: normalizeString(value.thumb),
	} satisfies StatusFeedExternal;
}

function normalizeVideo(value: Record<string, unknown> | null | undefined) {
	if (!value) {
		return null;
	}

	const playlist = normalizeString(value.playlist);
	if (!playlist) {
		return null;
	}

	const aspectRatio =
		(value.aspectRatio as Record<string, unknown> | null | undefined) || null;

	return {
		playlist,
		thumbnail: normalizeString(value.thumbnail),
		alt: normalizeString(value.alt),
		width: Number(aspectRatio?.width || 0),
		height: Number(aspectRatio?.height || 0),
	} satisfies StatusFeedVideo;
}

function normalizeQuotedPost(value: Record<string, unknown> | null | undefined) {
	if (!value) {
		return null;
	}

	const blueskyUrl = normalizeString(value.blueskyUrl);
	if (!blueskyUrl) {
		return null;
	}

	return {
		uri: normalizeString(value.uri),
		blueskyUrl,
		displayName: normalizeString(value.displayName),
		handle: normalizeString(value.handle),
		avatar: normalizeString(value.avatar),
		date: new Date(normalizeString(value.date)),
		text: normalizeString(value.text),
		html: normalizeString(value.html),
		images: Array.isArray(value.images)
			? value.images.map((image) => normalizeImage(image as Record<string, unknown>))
			: [],
		external: normalizeExternal((value.external as Record<string, unknown> | null) || null),
		video: normalizeVideo((value.video as Record<string, unknown> | null) || null),
	} satisfies StatusFeedQuotedPost;
}

function normalizeReplyTo(value: Record<string, unknown> | null | undefined) {
	if (!value) {
		return null;
	}

	const blueskyUrl = normalizeString(value.blueskyUrl);
	if (!blueskyUrl) {
		return null;
	}

	return {
		uri: normalizeString(value.uri) || null,
		blueskyUrl,
		displayName: normalizeString(value.displayName),
		handle: normalizeString(value.handle),
	} satisfies StatusFeedReplyTo;
}

function normalizeStatus(value: Record<string, unknown>): StatusFeedItem {
	return {
		id: normalizeString(value.id),
		uri: normalizeString(value.uri),
		slug: normalizeString(value.slug),
		text: normalizeString(value.text),
		html: normalizeString(value.html),
		date: new Date(normalizeString(value.date)),
		blueskyUrl: normalizeString(value.blueskyUrl),
		displayName: normalizeString(value.displayName),
		handle: normalizeString(value.handle),
		avatar: normalizeString(value.avatar),
		isReply: Boolean(value.isReply),
		replyCount: Number(value.replyCount || 0),
		repostCount: Number(value.repostCount || 0),
		quoteCount: Number(value.quoteCount || 0),
		likeCount: Number(value.likeCount || 0),
		images: Array.isArray(value.images)
			? value.images.map((image) => normalizeImage(image as Record<string, unknown>))
			: [],
		external: normalizeExternal((value.external as Record<string, unknown> | null) || null),
		video: normalizeVideo((value.video as Record<string, unknown> | null) || null),
		quotedPost: normalizeQuotedPost((value.quotedPost as Record<string, unknown> | null) || null),
		replyTo: normalizeReplyTo((value.replyTo as Record<string, unknown> | null) || null),
		replies: Array.isArray(value.replies)
			? value.replies.map((reply) => normalizeStatus(reply as Record<string, unknown>))
			: [],
	};
}

function getPrimaryRepo() {
	return String(
		process.env.ATPROTO_REPOS ||
			process.env.ATPROTO_REPO ||
			process.env.STANDARD_SITE_IDENTIFIER ||
			process.env.ATPROTO_IDENTIFIER ||
			DEFAULT_REPO,
	)
		.split(",")
		.map((value) => value.trim())
		.find(Boolean) || DEFAULT_REPO;
}

function getStatusPageCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroStatusFeedCache?: Map<string, StatusFeedCacheEntry>;
	};

	if (!scope.__afterwordAstroStatusFeedCache) {
		scope.__afterwordAstroStatusFeedCache = new Map();
	}

	return scope.__afterwordAstroStatusFeedCache;
}

function escapeHtml(value: string) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderTextHtml(text: string) {
	const trimmed = String(text || "").trim();

	if (!trimmed) {
		return "";
	}

	return trimmed
		.split(/\n{2,}/)
		.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function getRecordKey(uri: string | undefined | null) {
	return String(uri || "").split("/").pop() || "";
}

function getPostUrl(uri: string, handle: string) {
	return `https://bsky.app/profile/${handle}/post/${getRecordKey(uri)}`;
}

function getImagesFromEmbed(embed: Record<string, any> | null | undefined) {
	if (!embed) {
		return [];
	}

	const imageViews = embed.images || embed.media?.images || [];
	return imageViews.map((image: Record<string, any>) => normalizeImage(image));
}

function getImages(post: Record<string, any>) {
	return getImagesFromEmbed(post.embed || post.record?.embed);
}

function getExternalFromEmbed(embed: Record<string, any> | null | undefined): StatusFeedExternal | null {
	if (!embed) {
		return null;
	}

	const external = embed.external || embed.media?.external;

	if (!external || !external.uri) {
		return null;
	}

	let domain = external.uri;

	try {
		domain = new URL(external.uri).hostname.replace(/^www\./, "");
	} catch {
		// Keep the raw URI if it cannot be parsed.
	}

	return {
		uri: external.uri,
		title: external.title || domain,
		description: external.description || "",
		domain,
		thumb:
			normalizeString(external.thumb) ||
			normalizeString(external.image?.thumb) ||
			normalizeString(external.image?.url),
	};
}

function getExternal(post: Record<string, any>) {
	return getExternalFromEmbed(post.embed || post.record?.embed);
}

function getVideoFromEmbed(embed: Record<string, any> | null | undefined): StatusFeedVideo | null {
	if (!embed) {
		return null;
	}

	const video = embed.playlist ? embed : embed.video || embed.media?.video || null;
	return normalizeVideo(video);
}

function getVideo(post: Record<string, any>) {
	return getVideoFromEmbed(post.embed || post.record?.embed);
}

function getImagesFromEmbedViews(embeds: Array<Record<string, any>> | undefined): StatusFeedImage[] {
	if (!Array.isArray(embeds) || !embeds.length) {
		return [];
	}

	const seen = new Set<string>();
	const images: StatusFeedImage[] = [];

	for (const embed of embeds) {
		for (const image of getImagesFromEmbed(embed)) {
			const key = `${image.fullsize}::${image.thumb}`;
			if (seen.has(key)) continue;
			seen.add(key);
			images.push(image);
		}
	}

	return images;
}

function getExternalFromEmbedViews(embeds: Array<Record<string, any>> | undefined) {
	if (!Array.isArray(embeds) || !embeds.length) {
		return null;
	}

	for (const embed of embeds) {
		const external = getExternalFromEmbed(embed);
		if (external) {
			return external;
		}
	}

	return null;
}

function getVideoFromEmbedViews(embeds: Array<Record<string, any>> | undefined) {
	if (!Array.isArray(embeds) || !embeds.length) {
		return null;
	}

	for (const embed of embeds) {
		const video = getVideoFromEmbed(embed);
		if (video) {
			return video;
		}
	}

	return null;
}

function getQuotedPost(post: Record<string, any>): StatusFeedQuotedPost | null {
	const embed = post.embed || post.record?.embed;
	const recordView = embed?.record?.record || embed?.record;

	if (!recordView || recordView.$type !== "app.bsky.embed.record#viewRecord") {
		return null;
	}

	const author = recordView.author || {};
	const handle = String(author.handle || "").trim();
	const text = String(recordView.value?.text || "");
	const embeds = Array.isArray(recordView.embeds) ? recordView.embeds : [];

	return {
		uri: String(recordView.uri || ""),
		date: new Date(String(recordView.value?.createdAt || recordView.indexedAt || new Date().toISOString())),
		blueskyUrl: getPostUrl(String(recordView.uri || ""), handle),
		displayName: author.displayName || handle,
		handle: handle ? `@${handle}` : "",
		avatar: author.avatar || "",
		text,
		html: renderTextHtml(text),
		images: getImagesFromEmbedViews(embeds),
		external: getExternalFromEmbedViews(embeds),
		video: getVideoFromEmbedViews(embeds),
	};
}

function getReplyParent(node: Record<string, any> | null): StatusFeedReplyTo | null {
	if (!node || node.$type !== "app.bsky.feed.defs#threadViewPost" || !node.post) {
		return null;
	}

	const parentPost = node.post;
	const author = parentPost.author || {};
	const handle = author.handle || getPrimaryRepo();

	return {
		uri: parentPost.uri || null,
		displayName: author.displayName || handle,
		handle: `@${handle}`,
		blueskyUrl: getPostUrl(parentPost.uri, handle),
	};
}

function normalizeReply(node: Record<string, any>): StatusFeedItem | null {
	if (!node || node.$type !== "app.bsky.feed.defs#threadViewPost" || !node.post) {
		return null;
	}

	const post = node.post;
	const author = post.author || {};
	const record = post.record || {};
	const handle = author.handle || "";

	return {
		id: String(post.uri || ""),
		uri: String(post.uri || ""),
		slug: getRecordKey(post.uri),
		text: String(record.text || ""),
		html: renderTextHtml(String(record.text || "")),
		date: new Date(String(record.createdAt || post.indexedAt || new Date().toISOString())),
		blueskyUrl: getPostUrl(String(post.uri || ""), handle),
		displayName: author.displayName || handle,
		handle: handle ? `@${handle}` : "",
		avatar: author.avatar || "",
		isReply: Boolean(record.reply?.parent?.uri),
		replyCount: Number(post.replyCount || 0),
		repostCount: Number(post.repostCount || 0),
		quoteCount: Number(post.quoteCount || 0),
		likeCount: Number(post.likeCount || 0),
		images: getImages(post),
		external: getExternal(post),
		video: getVideo(post),
		quotedPost: getQuotedPost(post),
		replyTo: null,
		replies: Array.isArray(node.replies)
			? node.replies.map(normalizeReply).filter(Boolean) as StatusFeedItem[]
			: [],
	};
}

function normalizeFeedItem(item: Record<string, any>, actor: string): StatusFeedItem | null {
	const post = item.post || {};
	const author = post.author || {};
	const record = post.record || {};
	const handle = author.handle || actor;

	if (item.reason?.$type === "app.bsky.feed.defs#reasonRepost") {
		return null;
	}

	return {
		id: String(post.uri || ""),
		uri: String(post.uri || ""),
		slug: getRecordKey(post.uri),
		text: String(record.text || ""),
		html: renderTextHtml(String(record.text || "")),
		date: new Date(String(record.createdAt || post.indexedAt || new Date().toISOString())),
		blueskyUrl: getPostUrl(String(post.uri || ""), handle),
		displayName: author.displayName || handle,
		handle: `@${handle}`,
		avatar: author.avatar || "",
		isReply: Boolean(record.reply?.parent?.uri),
		replyCount: Number(post.replyCount || 0),
		repostCount: Number(post.repostCount || 0),
		quoteCount: Number(post.quoteCount || 0),
		likeCount: Number(post.likeCount || 0),
		images: getImages(post),
		external: getExternal(post),
		video: getVideo(post),
		quotedPost: getQuotedPost(post),
		replyTo: null,
		replies: [],
	};
}

async function fetchThreadContextForPost(post: StatusFeedItem) {
	if (!post.uri) {
		return post;
	}

	try {
		const response = await fetchWithTimeout(
			`${THREAD_URL}?uri=${encodeURIComponent(post.uri)}&depth=10`,
			{
				headers: { accept: "application/json" },
			},
			STATUS_FETCH_TIMEOUT_MS,
		);

		if (!response.ok) {
			throw new Error(`Thread request failed with ${response.status}`);
		}

		const data = (await response.json()) as { thread?: Record<string, any> };
		const replies = Array.isArray(data.thread?.replies)
			? data.thread.replies.map(normalizeReply).filter(Boolean) as StatusFeedItem[]
			: [];
		const replyTo = getReplyParent((data.thread?.parent as Record<string, any>) || null);

		return {
			...post,
			replyTo: post.replyTo || replyTo,
			replies,
		} satisfies StatusFeedItem;
	} catch (error) {
		console.warn(`[status] Unable to fetch thread for ${post.uri}:`, error);
		return post;
	}
}

export async function getStatusFeedPage(options?: {
	cursor?: string | null;
	limit?: number;
	includeReplies?: boolean;
}) {
	const limit = Math.max(1, Math.min(Math.floor(options?.limit ?? DEFAULT_LIMIT), 40));
	const cursor = normalizeString(options?.cursor) || null;
	const includeReplies = Boolean(options?.includeReplies);
	const actor = getPrimaryRepo();
	const cacheKey = `${actor}:${limit}:${cursor || "first"}:${includeReplies ? "with-replies" : "no-replies"}`;
	const cache = getStatusPageCache();
	const cached = cache.get(cacheKey);

	if (cached && cached.expiresAt > Date.now()) {
		return cached.page;
	}

	try {
		const statuses: StatusFeedItem[] = [];
		let nextCursor = cursor;
		let requestCursor = cursor;
		let requests = 0;

		while (statuses.length < limit && requests < 4) {
			const remaining = limit - statuses.length;
			const chunkLimit = includeReplies ? remaining : Math.min(remaining + 6, 20);
			const params = new URLSearchParams({
				actor,
				limit: String(Math.max(1, Math.min(chunkLimit, 40))),
			});

			if (requestCursor) {
				params.set("cursor", requestCursor);
			}

			const response = await fetchWithTimeout(
				`${AUTHOR_FEED_URL}?${params.toString()}`,
				{
					headers: {
						accept: "application/json",
					},
				},
				STATUS_FETCH_TIMEOUT_MS,
			);

			if (!response.ok) {
				throw new Error(`Bluesky author feed request failed with ${response.status}`);
			}

			const payload = (await response.json()) as {
				feed?: Array<Record<string, unknown>>;
				cursor?: string | null;
				limit?: number;
			};

			const chunk = Array.isArray(payload.feed)
				? payload.feed
						.map((status) => normalizeFeedItem(status, actor))
						.filter((status): status is StatusFeedItem => Boolean(status))
						.filter((status) => (includeReplies ? true : !status.isReply))
				: [];

			statuses.push(...chunk);
			nextCursor = normalizeString(payload.cursor) || null;
			requestCursor = nextCursor;
			requests += 1;

			if (!nextCursor || !Array.isArray(payload.feed) || payload.feed.length === 0) {
				break;
			}
		}

		const page = {
			statuses: statuses.slice(0, limit),
			cursor: nextCursor,
			limit,
		} satisfies StatusFeedPage;

		cache.set(cacheKey, {
			expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
			page,
		});

		return page;
	} catch (error) {
		if (cached) {
			console.warn(`[status] Falling back to stale cached feed page for ${cacheKey}:`, error);
			return cached.page;
		}

		console.warn(`[status] Returning empty feed page for ${cacheKey}:`, error);
		return {
			statuses: [],
			cursor: null,
			limit,
		} satisfies StatusFeedPage;
	}
}

export async function getStatusBySlug(slug: string) {
	const normalizedSlug = normalizeString(slug);

	if (!normalizedSlug) {
		return null;
	}

	let cursor: string | null = null;
	let pageCount = 0;

	while (pageCount < STATUS_LOOKUP_PAGE_LIMIT) {
		const page = await getStatusFeedPage({
			cursor,
			limit: 50,
			includeReplies: true,
		});

		const match = page.statuses.find((item) => item.slug === normalizedSlug);

		if (match) {
			return fetchThreadContextForPost(match);
		}

		if (!page.cursor) {
			break;
		}

		cursor = page.cursor;
		pageCount += 1;
	}

	return null;
}
