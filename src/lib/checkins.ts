import { fetchWithTimeout } from "./network";

const CHECKINS_API_URL = "https://sync.afterword.blog/api/checkins";
const DEFAULT_CHECKIN_PAGE_SIZE = 20;
const CHECKINS_FETCH_TIMEOUT_MS = 2_500;
const CHECKINS_CACHE_TTL_MS = 60_000;

type RuntimeEnv = Record<string, unknown>;

export type CheckinItem = {
	id: string;
	uri: string;
	cid: string;
	slug: string;
	canonicalPath: string;
	name: string;
	note: string;
	excerpt: string;
	address: string;
	locality: string;
	region: string;
	country: string;
	place: string;
	timezone: string;
	latitude: number | null;
	longitude: number | null;
	website: string;
	venueCategory: string;
	visibility: string;
	tags: string[];
	createdAt: Date;
	visitedAt: Date;
	coverImage: string | null;
	photoUrls: string[];
	mapEmbedUrl: string | null;
	appleMapsUrl: string | null;
	mapPreviewPath: string | null;
	imported: boolean;
};

export type CheckinPage = {
	items: CheckinItem[];
	nextCursor: string | null;
};

type SerializedCheckinItem = Omit<CheckinItem, "createdAt" | "visitedAt"> & {
	createdAt: string;
	visitedAt: string;
};

type CachedCheckinList = {
	expiresAt: number;
	items: CheckinItem[];
};

type CachedCheckinPage = {
	expiresAt: number;
	page: CheckinPage;
};

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function getCheckinsApiBaseUrl(env: RuntimeEnv) {
	return normalizeString(env.CHECKINS_API_URL || env.SYNC_SITE_URL || CHECKINS_API_URL).replace(/\/+$/, "");
}

function hydrateSerializedCheckin(item: SerializedCheckinItem): CheckinItem {
	return {
		...item,
		createdAt: new Date(item.createdAt),
		visitedAt: new Date(item.visitedAt),
	};
}

function getCheckinsCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroCheckinsCache?: CachedCheckinList | null;
		__afterwordAstroCheckinsPromise?: Promise<CheckinItem[]> | null;
		__afterwordAstroCheckinsPageCache?: Map<string, CachedCheckinPage>;
		__afterwordAstroLatestCheckinCache?: { expiresAt: number; item: CheckinItem | null } | null;
		__afterwordAstroLatestCheckinPromise?: Promise<CheckinItem | null> | null;
	};

	if (!("__afterwordAstroCheckinsCache" in scope)) {
		scope.__afterwordAstroCheckinsCache = null;
		scope.__afterwordAstroCheckinsPromise = null;
		scope.__afterwordAstroLatestCheckinCache = null;
		scope.__afterwordAstroLatestCheckinPromise = null;
	}

	if (!scope.__afterwordAstroCheckinsPageCache) {
		scope.__afterwordAstroCheckinsPageCache = new Map();
	}

	return scope;
}

function buildPageCacheKey(limit: number, cursor: string | null) {
	return JSON.stringify({ limit, cursor: cursor || null });
}

function sliceCheckinsPage(items: CheckinItem[], limit: number, cursor: string | null): CheckinPage {
	const normalizedCursor = normalizeString(cursor) || null;
	const startIndex = normalizedCursor
		? Math.max(
				0,
				items.findIndex((item) => item.slug === normalizedCursor || item.id === normalizedCursor) + 1,
		  )
		: 0;
	const pageItems = items.slice(startIndex, startIndex + limit);
	const nextItem = items[startIndex + limit] || null;

	return {
		items: pageItems,
		nextCursor: nextItem?.slug || nextItem?.id || null,
	};
}

async function fetchCheckinsApiPage(
	env: RuntimeEnv,
	{ limit, cursor }: { limit: number; cursor?: string | null },
): Promise<CheckinPage> {
	const params = new URLSearchParams({
		limit: String(limit),
	});

	if (cursor) {
		params.set("cursor", cursor);
	}

	const response = await fetchWithTimeout(
		`${getCheckinsApiBaseUrl(env)}?${params.toString()}`,
		{
			headers: { accept: "application/json" },
		},
		CHECKINS_FETCH_TIMEOUT_MS,
	);

	if (!response.ok) {
		throw new Error(`check-ins API request failed with ${response.status}`);
	}

	const payload = (await response.json()) as {
		items?: SerializedCheckinItem[];
		pageInfo?: { nextCursor?: string | null };
	};

	return {
		items: Array.isArray(payload.items) ? payload.items.map((item) => hydrateSerializedCheckin(item)) : [],
		nextCursor: normalizeString(payload.pageInfo?.nextCursor) || null,
	};
}

async function fetchAllCheckinsFromApi(env: RuntimeEnv) {
	const items: CheckinItem[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;

	for (;;) {
		const page = await fetchCheckinsApiPage(env, { limit: 100, cursor });

		for (const item of page.items) {
			const key = String(item.canonicalPath || item.slug || item.id).trim();
			if (!key || seen.has(key)) continue;
			seen.add(key);
			items.push(item);
		}

		if (!page.nextCursor) {
			break;
		}

		cursor = page.nextCursor;
	}

	return items.sort((a, b) => b.visitedAt.getTime() - a.visitedAt.getTime());
}

export async function getCheckins(env: RuntimeEnv) {
	const scope = getCheckinsCache();
	const cached = scope.__afterwordAstroCheckinsCache;
	if (cached && cached.expiresAt > Date.now()) {
		return cached.items;
	}

	if (!scope.__afterwordAstroCheckinsPromise) {
		scope.__afterwordAstroCheckinsPromise = fetchAllCheckinsFromApi(env)
			.then((items) => {
				scope.__afterwordAstroCheckinsCache = {
					expiresAt: Date.now() + CHECKINS_CACHE_TTL_MS,
					items,
				};
				return items;
			})
			.finally(() => {
				scope.__afterwordAstroCheckinsPromise = null;
			});
	}

	try {
		return await scope.__afterwordAstroCheckinsPromise;
	} catch (error) {
		if (cached?.items.length) {
			console.warn("[checkins] Returning stale cached check-ins after API failure:", error);
			return cached.items;
		}

		console.warn("[checkins] Returning empty check-in list after API failure:", error);
		return [];
	}
}

export async function getCheckinsPage(
	env: RuntimeEnv,
	{ limit = DEFAULT_CHECKIN_PAGE_SIZE, cursor = null }: { limit?: number; cursor?: string | null } = {},
): Promise<CheckinPage> {
	const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 40));
	const normalizedCursor = normalizeString(cursor) || null;
	const cacheKey = buildPageCacheKey(normalizedLimit, normalizedCursor);
	const scope = getCheckinsCache();
	const cachedPage = scope.__afterwordAstroCheckinsPageCache?.get(cacheKey);

	if (cachedPage && cachedPage.expiresAt > Date.now()) {
		return cachedPage.page;
	}

	try {
		const page = await fetchCheckinsApiPage(env, {
			limit: normalizedLimit,
			cursor: normalizedCursor,
		});

		scope.__afterwordAstroCheckinsPageCache?.set(cacheKey, {
			expiresAt: Date.now() + CHECKINS_CACHE_TTL_MS,
			page,
		});
		return page;
	} catch (error) {
		if (cachedPage?.page.items.length) {
			console.warn("[checkins] Returning stale cached page after API failure:", error);
			return cachedPage.page;
		}

		const items = await getCheckins(env);
		if (items.length) {
			return sliceCheckinsPage(items, normalizedLimit, normalizedCursor);
		}

		console.warn("[checkins] Returning empty check-in page after API failure:", error);
		return {
			items: [],
			nextCursor: null,
		};
	}
}

export async function getLatestCheckin(env: RuntimeEnv) {
	const scope = getCheckinsCache();
	if (scope.__afterwordAstroLatestCheckinCache && scope.__afterwordAstroLatestCheckinCache.expiresAt > Date.now()) {
		return scope.__afterwordAstroLatestCheckinCache.item;
	}

	if (!scope.__afterwordAstroLatestCheckinPromise) {
		scope.__afterwordAstroLatestCheckinPromise = getCheckinsPage(env, { limit: 1 })
			.then((page) => {
				const item = page.items[0] || null;
				scope.__afterwordAstroLatestCheckinCache = {
					expiresAt: Date.now() + CHECKINS_CACHE_TTL_MS,
					item,
				};
				return item;
			})
			.finally(() => {
				scope.__afterwordAstroLatestCheckinPromise = null;
			});
	}

	return scope.__afterwordAstroLatestCheckinPromise;
}

export async function getCheckinBySlug(env: RuntimeEnv, slug: string) {
	const checkins = await getCheckins(env);
	return checkins.find((item) => item.slug === slug) || null;
}
