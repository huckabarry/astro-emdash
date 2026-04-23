import { fetchWithTimeout } from "./network";

const CHECKINS_API_URL = "https://sync.afterword.blog/api/checkins";
const PLC_DIRECTORY_URL = "https://plc.directory";
const RESOLVE_HANDLE_URL = "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle";
const CHECKIN_COLLECTION = "blog.afterword.checkin";
const DEFAULT_REPO = "did:plc:vt4k6d3e5rjw65cuzaf3nufq";
const DEFAULT_CHECKIN_PAGE_SIZE = 20;
const CHECKINS_FETCH_TIMEOUT_MS = 2_500;

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

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function getCheckinsApiBaseUrl(env: RuntimeEnv) {
	return normalizeString(env.CHECKINS_API_URL || env.SYNC_SITE_URL || CHECKINS_API_URL).replace(/\/+$/, "");
}

function getRecordKey(uri: string | undefined | null) {
	return String(uri || "").split("/").pop() || "";
}

function getPrimaryRepo(env: RuntimeEnv) {
	return normalizeString(
		env.ATPROTO_REPO || env.STANDARD_SITE_IDENTIFIER || env.ATPROTO_IDENTIFIER || DEFAULT_REPO,
	);
}

function getConfiguredServiceUrl(env: RuntimeEnv) {
	return normalizeString(env.STANDARD_SITE_PDS_URL || env.ATPROTO_PDS_URL || "").replace(/\/+$/, "");
}

function getCheckinsCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroCheckinsCache?: { expiresAt: number; items: CheckinItem[] } | null;
		__afterwordAstroCheckinsPromise?: Promise<CheckinItem[]> | null;
		__afterwordAstroCheckinsPageCache?: Map<string, { expiresAt: number; page: CheckinPage }>;
		__afterwordAstroLatestCheckinCache?: { expiresAt: number; item: CheckinItem | null } | null;
		__afterwordAstroLatestCheckinPromise?: Promise<CheckinItem | null> | null;
		__afterwordAstroDidCache?: Map<string, string>;
		__afterwordAstroPdsCache?: Map<string, string>;
	};

	if (!("__afterwordAstroCheckinsCache" in scope)) {
		scope.__afterwordAstroCheckinsCache = null;
		scope.__afterwordAstroCheckinsPromise = null;
		scope.__afterwordAstroLatestCheckinCache = null;
		scope.__afterwordAstroLatestCheckinPromise = null;
	}

	if (!scope.__afterwordAstroDidCache) {
		scope.__afterwordAstroDidCache = new Map();
	}

	if (!scope.__afterwordAstroPdsCache) {
		scope.__afterwordAstroPdsCache = new Map();
	}

	if (!scope.__afterwordAstroCheckinsPageCache) {
		scope.__afterwordAstroCheckinsPageCache = new Map();
	}

	return scope;
}

async function resolveAtprotoDid(identifier: string) {
	const normalized = normalizeString(identifier);
	if (!normalized) {
		throw new Error("ATProto identifier is not configured.");
	}

	if (normalized.startsWith("did:")) {
		return normalized;
	}

	const scope = getCheckinsCache();
	const cached = scope.__afterwordAstroDidCache?.get(normalized);
	if (cached) return cached;

	const response = await fetchWithTimeout(
		`${RESOLVE_HANDLE_URL}?handle=${encodeURIComponent(normalized)}`,
		{},
		CHECKINS_FETCH_TIMEOUT_MS,
	);
	if (!response.ok) {
		throw new Error(`Unable to resolve ATProto handle ${normalized}: ${response.status}`);
	}

	const payload = (await response.json()) as { did?: string };
	const did = normalizeString(payload.did);
	if (!did) {
		throw new Error(`ATProto handle ${normalized} did not resolve to a DID.`);
	}

	scope.__afterwordAstroDidCache?.set(normalized, did);
	return did;
}

async function resolveAtprotoService(env: RuntimeEnv, identifier: string) {
	const did = await resolveAtprotoDid(identifier);
	const configuredServiceUrl = getConfiguredServiceUrl(env);
	if (configuredServiceUrl) {
		return { did, serviceUrl: configuredServiceUrl };
	}

	const scope = getCheckinsCache();
	const cached = scope.__afterwordAstroPdsCache?.get(did);
	if (cached) {
		return { did, serviceUrl: cached };
	}

	const response = await fetchWithTimeout(`${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`, {}, CHECKINS_FETCH_TIMEOUT_MS);
	if (!response.ok) {
		throw new Error(`Unable to resolve DID document for ${did}: ${response.status}`);
	}

	const payload = (await response.json()) as {
		service?: Array<{ type?: string; serviceEndpoint?: string }>;
	};
	const serviceUrl =
		payload.service?.find((service) => service.type === "AtprotoPersonalDataServer")?.serviceEndpoint || "";
	if (!serviceUrl) {
		throw new Error(`DID document for ${did} did not include a PDS service endpoint.`);
	}

	const normalizedUrl = serviceUrl.replace(/\/+$/, "");
	scope.__afterwordAstroPdsCache?.set(did, normalizedUrl);
	return { did, serviceUrl: normalizedUrl };
}

function getBlobUrl(serviceUrl: string, did: string, cid: string) {
	return `${serviceUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}

function getCheckinMapPreviewPath(sourceId: string, latitude: number | null, longitude: number | null) {
	if (typeof latitude !== "number" || typeof longitude !== "number") {
		return null;
	}

	const params = new URLSearchParams({
		v: "2",
		lat: latitude.toFixed(6),
		lng: longitude.toFixed(6),
	});

	return `/check-ins/map/${encodeURIComponent(sourceId)}?${params.toString()}`;
}

function toCoordinate(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function roundCoordinate(value: number | null, decimals: number) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Number(value.toFixed(decimals));
}

function normalizeVenueCategory(value: unknown) {
	const normalized = String(value || "")
		.trim()
		.replace(/^mkpoicategory/i, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "";
}

function getDisplayCoordinates(latitude: number | null, longitude: number | null, visibility: string) {
	if (visibility === "private") return { latitude: null, longitude: null };
	if (typeof latitude !== "number" || typeof longitude !== "number") {
		return { latitude: null, longitude: null };
	}
	if (visibility === "approximate") {
		return {
			latitude: roundCoordinate(latitude, 3),
			longitude: roundCoordinate(longitude, 3),
		};
	}
	return { latitude, longitude };
}

function getMapEmbedUrl(latitude: number | null, longitude: number | null) {
	if (typeof latitude !== "number" || typeof longitude !== "number") return null;
	const latDelta = 0.012;
	const lonDelta = 0.02;
	const left = longitude - lonDelta;
	const right = longitude + lonDelta;
	const top = latitude + latDelta;
	const bottom = latitude - latDelta;
	return `https://www.openstreetmap.org/export/embed.html?bbox=${left}%2C${bottom}%2C${right}%2C${top}&layer=mapnik&marker=${latitude}%2C${longitude}`;
}

function getAppleMapsUrl({
	name,
	latitude,
	longitude,
}: {
	name: string;
	latitude: number | null;
	longitude: number | null;
}) {
	if (typeof latitude !== "number" || typeof longitude !== "number") return null;
	const query = encodeURIComponent(name || "Check-in");
	return `https://maps.apple.com/?q=${query}&ll=${latitude},${longitude}`;
}

function normalizePlace(parts: string[]) {
	const cleaned = parts.map((part) => String(part || "").trim()).filter(Boolean);
	const normalized: string[] = [];

	for (const part of cleaned) {
		const previous = normalized.at(-1);
		if (!previous) {
			normalized.push(part);
			continue;
		}
		const previousLower = previous.toLowerCase();
		const partLower = part.toLowerCase();
		if (partLower === previousLower) continue;
		if (partLower.startsWith(`${previousLower},`)) {
			normalized.push(part.slice(previous.length + 1).trim());
			continue;
		}
		normalized.push(part);
	}

	return normalized.filter(Boolean).join(", ");
}

function getPhotoRefLink(value: unknown) {
	if (
		typeof value === "object" &&
		value &&
		"ref" in value &&
		typeof value.ref === "object" &&
		value.ref &&
		"$link" in value.ref
	) {
		return String((value.ref as { $link?: unknown }).$link || "");
	}
	return null;
}

function hydrateSerializedCheckin(item: SerializedCheckinItem): CheckinItem {
	return {
		...item,
		createdAt: new Date(String(item.createdAt || new Date().toISOString())),
		visitedAt: new Date(String(item.visitedAt || new Date().toISOString())),
		mapPreviewPath:
			typeof item.mapPreviewPath === "string" && item.mapPreviewPath
				? item.mapPreviewPath
				: getCheckinMapPreviewPath(
						normalizeString(item.id),
						typeof item.latitude === "number" ? item.latitude : null,
						typeof item.longitude === "number" ? item.longitude : null,
					),
		imported: typeof item.imported === "boolean" ? item.imported : true,
	};
}

function hydrateCheckinRecord(
	record: {
		uri?: string;
		cid?: string;
		value?: Record<string, unknown>;
	},
	did: string,
	serviceUrl: string,
): CheckinItem {
	const value = record.value || {};
	const coverCid = getPhotoRefLink(value.photo);
	const photos = Array.isArray(value.photos) ? value.photos : [];
	const photoUrls = photos
		.map((item) => getPhotoRefLink(item))
		.filter(Boolean)
		.map((cid) => getBlobUrl(serviceUrl, did, cid as string));

	const visitedAt = new Date(String(value.visitedAt || value.createdAt || new Date().toISOString()));
	const slug = normalizeString(value.slug || getRecordKey(record.uri));
	const canonicalPath = normalizeString(value.canonicalPath || `/check-ins/${slug}/`);
	const latitude = toCoordinate(value.latitude);
	const longitude = toCoordinate(value.longitude);
	const visibility = normalizeString(value.visibility || "public") || "public";
	const displayCoordinates = getDisplayCoordinates(latitude, longitude, visibility);
	const isPrivate = visibility === "private";
	const place = isPrivate
		? ""
		: normalizePlace([String(value.locality || ""), String(value.region || ""), String(value.country || "")]);
	const address = isPrivate ? "" : normalizeString(value.address);

	return {
		id: getRecordKey(record.uri),
		uri: normalizeString(record.uri),
		cid: normalizeString(record.cid),
		slug,
		canonicalPath,
		name: normalizeString(value.name) || "Untitled place",
		note: normalizeString(value.note),
		excerpt: normalizeString(value.excerpt),
		address,
		locality: normalizeString(value.locality),
		region: normalizeString(value.region),
		country: normalizeString(value.country),
		place,
		timezone: normalizeString(value.timezone),
		latitude: displayCoordinates.latitude,
		longitude: displayCoordinates.longitude,
		website: normalizeString(value.website),
		venueCategory: normalizeVenueCategory(value.venueCategory),
		visibility,
		tags: Array.isArray(value.tags) ? value.tags.map((tag) => String(tag)) : [],
		createdAt: new Date(String(value.createdAt || new Date().toISOString())),
		visitedAt,
		coverImage: coverCid ? getBlobUrl(serviceUrl, did, coverCid) : null,
		photoUrls,
		mapEmbedUrl: getMapEmbedUrl(displayCoordinates.latitude, displayCoordinates.longitude),
		appleMapsUrl: getAppleMapsUrl({
			name: normalizeString(value.name) || "Check-in",
			latitude: displayCoordinates.latitude,
			longitude: displayCoordinates.longitude,
		}),
		mapPreviewPath: getCheckinMapPreviewPath(
			getRecordKey(record.uri),
			displayCoordinates.latitude,
			displayCoordinates.longitude,
		),
		imported: true,
	};
}

async function fetchCheckinRecordsPage(
	env: RuntimeEnv,
	cursor: string | null,
	limit: number,
) {
	const repo = getPrimaryRepo(env);
	const { did, serviceUrl } = await resolveAtprotoService(env, repo);
	const params = new URLSearchParams({
		repo: did,
		collection: CHECKIN_COLLECTION,
		limit: String(limit),
	});

	if (cursor) {
		params.set("cursor", cursor);
	}

	const response = await fetchWithTimeout(
		`${serviceUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`,
		{
			headers: { accept: "application/json" },
		},
		CHECKINS_FETCH_TIMEOUT_MS,
	);

	if (!response.ok) {
		throw new Error(`check-in request failed with ${response.status}`);
	}

	const data = (await response.json()) as {
		cursor?: string;
		records?: Array<Record<string, unknown>>;
	};

	return {
		did,
		serviceUrl,
		cursor: normalizeString(data.cursor) || null,
		records: data.records || [],
	};
}

async function fetchCheckins(env: RuntimeEnv) {
	let cursor: string | null = null;
	const items: CheckinItem[] = [];
	const seen = new Set<string>();

	for (;;) {
		const page = await fetchCheckinRecordsPage(env, cursor, 100);

		for (const record of page.records) {
			const item = hydrateCheckinRecord(
				record as { uri?: string; cid?: string; value?: Record<string, unknown> },
				page.did,
				page.serviceUrl,
			);

			if (item.visibility === "private") {
				continue;
			}

			const key = String(item.canonicalPath || item.id).trim();
			if (!key || seen.has(key)) {
				continue;
			}

			seen.add(key);
			items.push(item);
		}

		if (!page.cursor) {
			break;
		}

		cursor = page.cursor;
	}

	return items.sort((a, b) => b.visitedAt.getTime() - a.visitedAt.getTime());
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
			const key = String(item.canonicalPath || item.id).trim();
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
			.catch(async (error) => {
				console.warn("[checkins] API fetch failed, falling back to direct PDS read:", error);
				return fetchCheckins(env);
			})
			.then((items) => {
				scope.__afterwordAstroCheckinsCache = {
					expiresAt: Date.now() + 60_000,
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
			console.warn("[checkins] Falling back to stale cached check-ins:", error);
			return cached.items;
		}

		console.warn("[checkins] Returning empty check-in list after fetch failure:", error);
		return [];
	}
}

export async function getCheckinsPage(
	env: RuntimeEnv,
	{ limit = DEFAULT_CHECKIN_PAGE_SIZE, cursor = null }: { limit?: number; cursor?: string | null } = {},
): Promise<CheckinPage> {
	const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 40));
	const normalizedCursor = normalizeString(cursor) || null;

	try {
		return await fetchCheckinsApiPage(env, {
			limit: normalizedLimit,
			cursor: normalizedCursor,
		});
	} catch (error) {
		console.warn("[checkins] API page fetch failed, falling back to cached full list:", error);
		const items = await getCheckins(env);
		const offset = normalizedCursor && /^\d+$/.test(normalizedCursor)
			? Math.max(0, Number.parseInt(normalizedCursor, 10))
			: 0;
		const pageItems = items.slice(offset, offset + normalizedLimit);
		const nextOffset = offset + normalizedLimit;

		return {
			items: pageItems,
			nextCursor: nextOffset < items.length ? String(nextOffset) : null,
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
					expiresAt: Date.now() + 60_000,
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
