const RESOLVE_HANDLE_URL = "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle";
const PLC_DIRECTORY_URL = "https://plc.directory";
const CHECKIN_COLLECTION = "blog.afterword.checkin";
const DEFAULT_REPO = "did:plc:vt4k6d3e5rjw65cuzaf3nufq";
const CHECKINS_CACHE_TTL_MS = 1000 * 60 * 5;

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
};

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function getRecordKey(uri: string | undefined | null) {
	return String(uri || "").split("/").pop() || "";
}

function getPrimaryRepo(env: RuntimeEnv) {
	return normalizeString(
		env.ATPROTO_REPO ||
			env.STANDARD_SITE_IDENTIFIER ||
			env.ATPROTO_IDENTIFIER ||
			env.ATP_IDENTIFIER ||
			DEFAULT_REPO,
	);
}

function getConfiguredServiceUrl(env: RuntimeEnv) {
	return normalizeString(
		env.STANDARD_SITE_PDS_URL || env.ATPROTO_PDS_URL || env.PDS_URL || env.ATP_BASE_URL || "",
	).replace(/\/+$/, "");
}

function getCheckinsCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroCheckinsCache?: { expiresAt: number; items: CheckinItem[] } | null;
		__afterwordAstroCheckinsPromise?: Promise<CheckinItem[]> | null;
	};

	if (!("__afterwordAstroCheckinsCache" in scope)) {
		scope.__afterwordAstroCheckinsCache = null;
		scope.__afterwordAstroCheckinsPromise = null;
	}

	return scope;
}

function getDidCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroCheckinDidCache?: Map<string, string>;
	};
	if (!scope.__afterwordAstroCheckinDidCache) {
		scope.__afterwordAstroCheckinDidCache = new Map();
	}
	return scope.__afterwordAstroCheckinDidCache;
}

function getPdsCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroCheckinPdsCache?: Map<string, string>;
	};
	if (!scope.__afterwordAstroCheckinPdsCache) {
		scope.__afterwordAstroCheckinPdsCache = new Map();
	}
	return scope.__afterwordAstroCheckinPdsCache;
}

async function resolveAtprotoDid(identifier: string) {
	const normalized = normalizeString(identifier);

	if (!normalized) {
		throw new Error("ATProto identifier is not configured.");
	}

	if (normalized.startsWith("did:")) {
		return normalized;
	}

	const cache = getDidCache();
	const cached = cache.get(normalized);
	if (cached) return cached;

	const response = await fetch(`${RESOLVE_HANDLE_URL}?handle=${encodeURIComponent(normalized)}`);
	if (!response.ok) {
		throw new Error(`Unable to resolve ATProto handle ${normalized}: ${response.status}`);
	}

	const payload = (await response.json()) as { did?: string };
	const did = normalizeString(payload.did);
	if (!did) {
		throw new Error(`ATProto handle ${normalized} did not resolve to a DID.`);
	}

	cache.set(normalized, did);
	return did;
}

async function resolveAtprotoService(identifier: string, env: RuntimeEnv) {
	const did = await resolveAtprotoDid(identifier);
	const configuredServiceUrl = getConfiguredServiceUrl(env);

	if (configuredServiceUrl) {
		return { did, serviceUrl: configuredServiceUrl };
	}

	const cache = getPdsCache();
	const cached = cache.get(did);
	if (cached) {
		return { did, serviceUrl: cached };
	}

	const response = await fetch(`${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`);
	if (!response.ok) {
		throw new Error(`Unable to resolve DID document for ${did}: ${response.status}`);
	}

	const payload = (await response.json()) as {
		service?: Array<{ type?: string; serviceEndpoint?: string }>;
	};
	const serviceUrl =
		payload.service?.find((service) => service.type === "AtprotoPersonalDataServer")
			?.serviceEndpoint || "";
	if (!serviceUrl) {
		throw new Error(`DID document for ${did} did not include a PDS service endpoint.`);
	}

	const normalizedUrl = serviceUrl.replace(/\/+$/, "");
	cache.set(did, normalizedUrl);
	return { did, serviceUrl: normalizedUrl };
}

function getBlobUrl(serviceUrl: string, did: string, cid: string) {
	return `${serviceUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}

function toCoordinate(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === "string") {
		const parsed = Number.parseFloat(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function roundCoordinate(value: number | null, decimals: number) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}

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
	if (visibility === "private") {
		return { latitude: null, longitude: null };
	}

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
	if (typeof latitude !== "number" || typeof longitude !== "number") {
		return null;
	}

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
	if (typeof latitude !== "number" || typeof longitude !== "number") {
		return null;
	}

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
		if (partLower === previousLower) {
			continue;
		}

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
		return String(value.ref.$link);
	}

	return null;
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
	const slug = String(value.slug || getRecordKey(record.uri) || "").trim();
	const canonicalPath = String(value.canonicalPath || `/check-ins/${slug}`).trim().replace(/\/+$/, "");
	const latitude = toCoordinate(value.latitude);
	const longitude = toCoordinate(value.longitude);
	const visibility = String(value.visibility || "public").trim() || "public";
	const displayCoordinates = getDisplayCoordinates(latitude, longitude, visibility);
	const isPrivate = visibility === "private";
	const place = isPrivate
		? ""
		: normalizePlace([
				String(value.locality || ""),
				String(value.region || ""),
				String(value.country || ""),
			]);
	const address = isPrivate ? "" : String(value.address || "").trim();

	return {
		id: getRecordKey(record.uri),
		uri: String(record.uri || ""),
		cid: String(record.cid || ""),
		slug,
		canonicalPath,
		name: String(value.name || "Untitled place"),
		note: String(value.note || "").trim(),
		excerpt: String(value.excerpt || "").trim(),
		address,
		locality: String(value.locality || "").trim(),
		region: String(value.region || "").trim(),
		country: String(value.country || "").trim(),
		place,
		timezone: String(value.timezone || "").trim(),
		latitude: displayCoordinates.latitude,
		longitude: displayCoordinates.longitude,
		website: String(value.website || "").trim(),
		venueCategory: normalizeVenueCategory(value.venueCategory),
		visibility,
		tags: Array.isArray(value.tags) ? value.tags.map((tag) => String(tag)) : [],
		createdAt: new Date(String(value.createdAt || new Date().toISOString())),
		visitedAt,
		coverImage: coverCid ? getBlobUrl(serviceUrl, did, coverCid) : null,
		photoUrls,
		mapEmbedUrl: getMapEmbedUrl(displayCoordinates.latitude, displayCoordinates.longitude),
		appleMapsUrl: getAppleMapsUrl({
			name: String(value.name || "Check-in"),
			latitude: displayCoordinates.latitude,
			longitude: displayCoordinates.longitude,
		}),
	};
}

async function fetchCheckins(env: RuntimeEnv) {
	const repo = getPrimaryRepo(env);
	const { did, serviceUrl } = await resolveAtprotoService(repo, env);
	const allRecords: CheckinItem[] = [];
	let cursor = "";
	let pageCount = 0;

	while (pageCount < 20) {
		const params = new URLSearchParams({
			repo: did,
			collection: CHECKIN_COLLECTION,
			limit: "100",
		});
		if (cursor) {
			params.set("cursor", cursor);
		}

		const response = await fetch(`${serviceUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`, {
			headers: { accept: "application/json" },
		});

		if (!response.ok) {
			throw new Error(`check-in request failed with ${response.status}`);
		}

		const data = (await response.json()) as {
			records?: Array<{ uri?: string; cid?: string; value?: Record<string, unknown> }>;
			cursor?: string;
		};

		allRecords.push(...(data.records || []).map((record) => hydrateCheckinRecord(record, did, serviceUrl)));
		cursor = normalizeString(data.cursor);
		pageCount += 1;
		if (!cursor) {
			break;
		}
	}

	const seenPaths = new Set<string>();

	return allRecords
		.filter((item) => {
			if (item.visibility === "private") {
				return false;
			}

			const key = String(item.canonicalPath || item.id || "").trim();
			if (!key || seenPaths.has(key)) {
				return false;
			}

			seenPaths.add(key);
			return true;
		})
		.sort((a, b) => b.visitedAt.getTime() - a.visitedAt.getTime());
}

export async function getCheckins(env: RuntimeEnv) {
	const scope = getCheckinsCache();
	const cached = scope.__afterwordAstroCheckinsCache;

	if (cached && cached.expiresAt > Date.now()) {
		return cached.items;
	}

	if (!scope.__afterwordAstroCheckinsPromise) {
		scope.__afterwordAstroCheckinsPromise = fetchCheckins(env)
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

	return scope.__afterwordAstroCheckinsPromise;
}

export async function getCheckinBySlug(env: RuntimeEnv, slug: string) {
	const checkins = await getCheckins(env);
	return checkins.find((item) => item.slug === slug) || null;
}
