const AUTHOR_FEED_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";
const RESOLVE_HANDLE_URL = "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle";
const PLC_DIRECTORY_URL = "https://plc.directory";
const STATUS_COLLECTION = "app.bsky.feed.post";
const CREATE_SESSION_NSID = "com.atproto.server.createSession";
const GET_RECORD_NSID = "com.atproto.repo.getRecord";
const PUT_RECORD_NSID = "com.atproto.repo.putRecord";
const DELETE_RECORD_NSID = "com.atproto.repo.deleteRecord";
const DEFAULT_REPO = "did:plc:vt4k6d3e5rjw65cuzaf3nufq";

export type StatusItem = {
	id: string;
	uri: string;
	slug: string;
	text: string;
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
	images: Array<{
		thumb: string;
		fullsize: string;
		alt: string;
	}>;
};

type RuntimeEnv = Record<string, unknown>;

type AtprotoSession = {
	serviceUrl: string;
	did: string;
	accessJwt: string;
	identifier: string;
};

type CachedAtprotoSession = AtprotoSession & {
	expiresAt: number;
};

function getStatusCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroStatusCache?: Map<string, { expiresAt: number; statuses: StatusItem[] }>;
	};
	if (!scope.__afterwordAstroStatusCache) {
		scope.__afterwordAstroStatusCache = new Map();
	}
	return scope.__afterwordAstroStatusCache;
}

function getDidCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroDidCache?: Map<string, string>;
	};
	if (!scope.__afterwordAstroDidCache) {
		scope.__afterwordAstroDidCache = new Map();
	}
	return scope.__afterwordAstroDidCache;
}

function getPdsCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroPdsCache?: Map<string, string>;
	};
	if (!scope.__afterwordAstroPdsCache) {
		scope.__afterwordAstroPdsCache = new Map();
	}
	return scope.__afterwordAstroPdsCache;
}

function getSessionCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroSessionCache?: CachedAtprotoSession | null;
		__afterwordAstroSessionPromise?: Promise<AtprotoSession> | null;
	};
	if (!("__afterwordAstroSessionCache" in scope)) {
		scope.__afterwordAstroSessionCache = null;
		scope.__afterwordAstroSessionPromise = null;
	}
	return scope;
}

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

function getConfiguredLoginIdentifiers(env: RuntimeEnv, repoIdentifier = getPrimaryRepo(env)) {
	return [
		env.STANDARD_SITE_LOGIN_IDENTIFIER,
		env.ATPROTO_LOGIN_IDENTIFIER,
		env.ATP_LOGIN_IDENTIFIER,
		env.STANDARD_SITE_EMAIL,
		env.ATPROTO_EMAIL,
		env.ATP_EMAIL,
		env.STANDARD_SITE_IDENTIFIER,
		env.ATPROTO_IDENTIFIER,
		env.ATP_IDENTIFIER,
		env.ATPROTO_REPO,
		repoIdentifier,
		DEFAULT_REPO,
	]
		.map((value) => normalizeString(value))
		.filter(Boolean)
		.filter((value, index, values) => values.indexOf(value) === index);
}

function getConfiguredAppPassword(env: RuntimeEnv) {
	return normalizeString(
		env.STANDARD_SITE_APP_PASSWORD || env.ATPROTO_APP_PASSWORD || env.ATP_APP_PASSWORD || "",
	);
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

async function resolveAtprotoService(identifier: string) {
	const did = await resolveAtprotoDid(identifier);
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

function getPostUrl(uri: string, handle: string) {
	return `https://bsky.app/profile/${handle}/post/${getRecordKey(uri)}`;
}

function normalizeImage(image: Record<string, any>) {
	return {
		thumb: image.thumb || image.fullsize,
		fullsize: image.fullsize || image.thumb,
		alt: image.alt || "",
	};
}

function getImages(post: Record<string, any>) {
	const embed = post.embed || post.record?.embed;
	if (!embed) return [];
	const imageViews = embed.images || embed.media?.images || [];
	return imageViews.map((image: Record<string, any>) => normalizeImage(image));
}

function normalizeStatus(item: Record<string, any>, actor: string): StatusItem | null {
	const post = item.post || {};
	const author = post.author || {};
	const record = post.record || {};
	const handle = normalizeString(author.handle || actor);

	if (item.reason?.$type === "app.bsky.feed.defs#reasonRepost") {
		return null;
	}

	return {
		id: String(post.uri || ""),
		uri: String(post.uri || ""),
		slug: getRecordKey(post.uri),
		text: String(record.text || ""),
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
	};
}

export async function getStatuses(env: RuntimeEnv, options?: { limit?: number; includeReplies?: boolean }) {
	const actor = getPrimaryRepo(env);
	const limit = Math.max(1, Math.min(Math.floor(options?.limit ?? 50), 100));
	const includeReplies = options?.includeReplies ?? true;
	const cacheKey = `${actor}:${limit}:${includeReplies ? "all" : "top"}`;
	const cache = getStatusCache();
	const cached = cache.get(cacheKey);

	if (cached && cached.expiresAt > Date.now()) {
		return cached.statuses;
	}

	const params = new URLSearchParams({
		actor,
		limit: String(limit),
	});
	const response = await fetch(`${AUTHOR_FEED_URL}?${params.toString()}`, {
		headers: { accept: "application/json" },
	});

	if (!response.ok) {
		throw new Error(`Bluesky feed request failed with ${response.status}`);
	}

	const data = (await response.json()) as { feed?: Array<Record<string, any>> };
	const statuses = (data.feed || [])
		.map((item) => normalizeStatus(item, actor))
		.filter((item): item is StatusItem => Boolean(item))
		.filter((item) => (includeReplies ? true : !item.isReply));

	cache.set(cacheKey, {
		expiresAt: Date.now() + 60_000,
		statuses,
	});

	return statuses;
}

function formatSessionCreationError(
	identifiers: string[],
	lastStatus: number | null,
	lastIdentifier: string | null,
) {
	const tried = identifiers.join(", ");
	if (lastStatus === 401) {
		return `ATProto session creation failed with 401 for ${lastIdentifier || "the configured identifiers"}. Tried: ${tried}.`;
	}
	if (lastStatus) {
		return `ATProto session creation failed with ${lastStatus} for ${lastIdentifier || "the configured identifiers"}. Tried: ${tried}.`;
	}
	return `ATProto session creation failed for the configured identifiers. Tried: ${tried}.`;
}

async function createSession(env: RuntimeEnv): Promise<AtprotoSession> {
	const repoIdentifier = getPrimaryRepo(env);
	const identifiers = getConfiguredLoginIdentifiers(env, repoIdentifier);
	const password = getConfiguredAppPassword(env);
	const configuredServiceUrl = getConfiguredServiceUrl(env);

	if (!repoIdentifier || !identifiers.length || !password) {
		throw new Error(
			"Status editing credentials are incomplete. Set STANDARD_SITE_APP_PASSWORD plus a repo or login identifier on this worker.",
		);
	}

	const { did: resolvedDid, serviceUrl } = configuredServiceUrl
		? { did: await resolveAtprotoDid(repoIdentifier), serviceUrl: configuredServiceUrl }
		: await resolveAtprotoService(repoIdentifier);

	const cache = getSessionCache();
	if (
		cache.__afterwordAstroSessionCache &&
		cache.__afterwordAstroSessionCache.expiresAt > Date.now() &&
		cache.__afterwordAstroSessionCache.serviceUrl === serviceUrl &&
		identifiers.includes(cache.__afterwordAstroSessionCache.identifier)
	) {
		return cache.__afterwordAstroSessionCache;
	}

	if (cache.__afterwordAstroSessionPromise) {
		return cache.__afterwordAstroSessionPromise;
	}

	cache.__afterwordAstroSessionPromise = (async () => {
		let lastError: Error | null = null;
		let lastStatus: number | null = null;
		let lastIdentifier: string | null = null;

		for (const identifier of identifiers) {
			try {
				const response = await fetch(`${serviceUrl}/xrpc/${CREATE_SESSION_NSID}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ identifier, password }),
				});

				if (!response.ok) {
					lastStatus = response.status;
					lastIdentifier = identifier;
					lastError = new Error(
						formatSessionCreationError(identifiers, lastStatus, lastIdentifier),
					);
					continue;
				}

				const payload = (await response.json()) as { did?: string; accessJwt?: string };
				const did = normalizeString(payload.did) || resolvedDid;
				const accessJwt = normalizeString(payload.accessJwt);
				if (!did || !accessJwt) {
					throw new Error("ATProto session did not return a DID and access token.");
				}

				const session: CachedAtprotoSession = {
					serviceUrl,
					did,
					accessJwt,
					identifier,
					expiresAt: Date.now() + 1000 * 60 * 20,
				};
				cache.__afterwordAstroSessionCache = session;
				return session;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error("ATProto session creation failed.");
			}
		}

		throw lastError || new Error(formatSessionCreationError(identifiers, lastStatus, lastIdentifier));
	})();

	try {
		return await cache.__afterwordAstroSessionPromise;
	} finally {
		cache.__afterwordAstroSessionPromise = null;
	}
}

async function getStatusRecord(env: RuntimeEnv, rkey: string) {
	const session = await createSession(env);
	const params = new URLSearchParams({
		repo: session.did,
		collection: STATUS_COLLECTION,
		rkey,
	});

	const response = await fetch(`${session.serviceUrl}/xrpc/${GET_RECORD_NSID}?${params.toString()}`, {
		headers: {
			authorization: `Bearer ${session.accessJwt}`,
			accept: "application/json",
		},
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`ATProto getRecord failed for ${STATUS_COLLECTION}/${rkey}: ${response.status} ${text}`);
	}

	return (await response.json()) as { value?: Record<string, unknown>; uri?: string; cid?: string };
}

export function getStatusRecordKey(uri: string) {
	const rkey = getRecordKey(uri);
	if (!rkey) {
		throw new Error("Unable to determine status record key.");
	}
	return rkey;
}

export async function updateStatusText(env: RuntimeEnv, rkey: string, text: string) {
	const session = await createSession(env);
	const existing = await getStatusRecord(env, rkey);
	const value = { ...(existing.value || {}) };

	value.$type = STATUS_COLLECTION;
	value.text = text;
	delete value.facets;
	delete value.entities;

	const response = await fetch(`${session.serviceUrl}/xrpc/${PUT_RECORD_NSID}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${session.accessJwt}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			repo: session.did,
			collection: STATUS_COLLECTION,
			rkey,
			record: value,
		}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`ATProto putRecord failed for ${STATUS_COLLECTION}/${rkey}: ${response.status} ${body}`);
	}

	return (await response.json()) as { uri?: string; cid?: string };
}

export async function deleteStatusRecord(env: RuntimeEnv, rkey: string) {
	const session = await createSession(env);
	const response = await fetch(`${session.serviceUrl}/xrpc/${DELETE_RECORD_NSID}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${session.accessJwt}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			repo: session.did,
			collection: STATUS_COLLECTION,
			rkey,
		}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`ATProto deleteRecord failed for ${STATUS_COLLECTION}/${rkey}: ${response.status} ${body}`);
	}
}

export function hasStatusEditCredentials(env: RuntimeEnv) {
	return Boolean(getConfiguredAppPassword(env) && getConfiguredLoginIdentifiers(env).length);
}
