import base from "@emdash-cms/plugin-atproto/sandbox";
import { after, getSiteSettings } from "emdash";
import { env } from "cloudflare:workers";
import jpeg from "jpeg-js";
import UPNG from "upng-js";

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const PUBLICATION_COLLECTION = "site.standard.publication";
const DOCUMENT_COLLECTION = "site.standard.document";
const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";
const MAX_BLOB_BYTES = 1_000_000;
const MAX_COVER_WIDTH = 1600;
const COVER_JPEG_QUALITIES = [82, 74, 68, 60, 52, 44];
const COVER_SCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.3];
const PUBLICATION_REFRESH_KEY = "state:publicationEnhancedAt";
const PUBLICATION_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DOCUMENT_REPAIR_PREFIX = "state:documentRepair:";
const DOCUMENT_REPAIR_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MAX_TEXT_CONTENT_LENGTH = 10_000;
const TAG_PREFIX_PATTERN = /^#/;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const WHITESPACE_PATTERN = /\s+/g;
const ENTRY_CONTENT_PATTERN =
	/<div[^>]*class=["'][^"']*entry__content[^"']*e-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const PARAGRAPH_PATTERN = /<(p|li|h[1-6]|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi;
const BR_PATTERN = /<br\s*\/?>/gi;
const PUBLICATION_METADATA_FALLBACKS = {
	"https://afterword.blog": {
		description: "Short updates, photos, and longer reflections on place, music, design, and daily life.",
		iconUrls: [
			"https://afterword-emdash-lab.bryan-robb.workers.dev/assets/images/status-avatar.jpg",
			"https://afterword.blog/assets/images/status-avatar.jpg",
		],
		basicTheme: {
			background: { r: 30, g: 32, b: 33 },
			foreground: { r: 235, g: 235, b: 235 },
			accent: { r: 242, g: 247, b: 183 },
			accentForeground: { r: 30, g: 32, b: 33 },
		},
	},
};
const CANONICAL_FETCH_FALLBACKS = {
	"https://afterword.blog": ["https://afterword-emdash-lab.bryan-robb.workers.dev"],
};

function withOrigin(url, origin) {
	if (!url) return url;
	if (url.startsWith("http://") || url.startsWith("https://")) return url;
	if (url.startsWith("/")) return origin ? `${origin}${url}` : url;
	return url;
}

function parseJsonMaybe(value) {
	if (typeof value !== "string") return value;
	const candidate = value.trim();
	if (!candidate || (!candidate.startsWith("{") && !candidate.startsWith("["))) return value;
	try {
		return JSON.parse(candidate);
	} catch {
		return value;
	}
}

function normalizeObjectValue(value) {
	const parsed = parseJsonMaybe(value);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function normalizeArrayValue(value) {
	const parsed = parseJsonMaybe(value);
	return Array.isArray(parsed) ? parsed : null;
}

function getFeaturedImageUrl(image, origin = "") {
	const value = normalizeObjectValue(image);
	if (!value) return null;

	if (typeof value.src === "string" && value.src.trim()) {
		return withOrigin(value.src.trim(), origin);
	}

	const asset = typeof value.asset === "object" && value.asset ? value.asset : undefined;
	if (typeof asset?.url === "string" && asset.url.trim()) {
		return withOrigin(asset.url.trim(), origin);
	}

	if (typeof asset?._ref === "string" && asset._ref.trim()) {
		return withOrigin(`/_emdash/api/media/file/${asset._ref.trim()}`, origin);
	}

	const meta = typeof value.meta === "object" && value.meta ? value.meta : undefined;
	const storageKey =
		(typeof meta?.storageKey === "string" && meta.storageKey.trim()) ||
		(typeof value.id === "string" && value.id.trim()) ||
		null;

	return storageKey ? withOrigin(`/_emdash/api/media/file/${storageKey}`, origin) : null;
}

function getFeaturedImageValue(content) {
	if (!content || typeof content !== "object" || Array.isArray(content)) return null;
	const data =
		typeof content.data === "object" && content.data && !Array.isArray(content.data) ? content.data : null;
	return normalizeObjectValue(content.featured_image) ?? normalizeObjectValue(data?.featured_image) ?? null;
}

function deriveCoverImage(content, siteUrl = "") {
	if (!content || typeof content !== "object" || Array.isArray(content)) return null;
	if (typeof content.cover_image === "string" && content.cover_image.trim()) {
		return content.cover_image.trim();
	}

	const featuredImage = getFeaturedImageValue(content);
	return getFeaturedImageUrl(featuredImage, siteUrl);
}

async function enrichContent(content, ctx) {
	const coverImage = deriveCoverImage(content, ctx.site?.url ?? "");
	if (!coverImage || !content || typeof content !== "object" || Array.isArray(content)) {
		return content;
	}

	const data =
		typeof content.data === "object" && content.data && !Array.isArray(content.data) ? content.data : null;

	return {
		...content,
		cover_image: coverImage,
		...(data ? { data: { ...data, cover_image: data.cover_image ?? coverImage } } : {}),
	};
}

async function prepareContentForPublish(event, ctx) {
	if (!event || typeof event !== "object" || !("content" in event)) {
		return event;
	}

	const collection =
		trimString(event.collection) ||
		trimString(event.content?.collection) ||
		trimString(event.content?.data?.collection);
	const hydrated = collection ? await hydrateContentForCover(collection, event.content, ctx) : event.content;
	const snapshot = collection ? await fetchCanonicalSnapshot(ctx, collection, hydrated) : null;
	const enriched = await enrichContent(applyCanonicalSnapshot(hydrated, snapshot), ctx);
	return { ...event, content: enriched };
}

function getHookHandler(entry) {
	if (!entry) return null;
	return typeof entry === "function" ? entry : entry.handler;
}

function wrapHook(entry) {
	const handler = getHookHandler(entry);
	if (!handler) return entry;

	const wrapped = async (event, ctx) => {
		const nextEvent = await prepareContentForPublish(event, ctx);
		return handler(nextEvent, ctx);
	};

	return typeof entry === "function" ? wrapped : { ...entry, handler: wrapped };
}

function wrapContentHook(entry, patchOptions = {}) {
	const handler = getHookHandler(entry);
	if (!handler) return entry;

	const wrapped = async (event, ctx) => {
		const nextEvent = await prepareContentForPublish(event, ctx);
		const result = await handler(nextEvent, ctx);
		await patchSyncedDocumentRecord(nextEvent, ctx, patchOptions);
		return result;
	};

	return typeof entry === "function" ? wrapped : { ...entry, handler: wrapped };
}

function trimString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function contentData(content) {
	return normalizeObjectValue(content?.data);
}

function contentValue(content, key) {
	const direct = trimString(content?.[key]);
	if (direct) return direct;
	return trimString(contentData(content)?.[key]);
}

function normalizeTags(content) {
	const candidates = content?.tags ?? contentData(content)?.tags;
	if (!Array.isArray(candidates)) return [];

	const tags = [];
	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			const tag = trimString(candidate.replace(TAG_PREFIX_PATTERN, ""));
			if (tag) tags.push(tag);
			continue;
		}
		if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
			const tag = trimString(candidate.name?.replace(TAG_PREFIX_PATTERN, ""));
			if (tag) tags.push(tag);
		}
	}
	return [...new Set(tags)];
}

function getPortableTextBlocks(content) {
	const candidates = [
		content?.content,
		contentData(content)?.content,
		content?.body,
		contentData(content)?.body,
	];

	for (const candidate of candidates) {
		const blocks = normalizeArrayValue(candidate);
		if (blocks?.length) return blocks;
	}

	return null;
}

function collectPortableTextStrings(value, parts) {
	if (!value) return;
	if (typeof value === "string") {
		const text = trimString(value);
		if (text) parts.push(text);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectPortableTextStrings(entry, parts);
		return;
	}
	if (typeof value !== "object") return;
	if (typeof value.text === "string") {
		const text = trimString(value.text);
		if (text) parts.push(text);
	}
	if (Array.isArray(value.children)) collectPortableTextStrings(value.children, parts);
	if (Array.isArray(value.items)) collectPortableTextStrings(value.items, parts);
}

function portableTextToPlainText(blocks) {
	if (!Array.isArray(blocks) || !blocks.length) return null;

	const segments = [];
	for (const block of blocks) {
		const parts = [];
		collectPortableTextStrings(block, parts);
		const text = parts.join(" ").replace(WHITESPACE_PATTERN, " ").trim();
		if (text) segments.push(text);
	}

	if (!segments.length) return null;
	return segments.join("\n\n").slice(0, MAX_TEXT_CONTENT_LENGTH);
}

function portableTextToItems(blocks) {
	if (!Array.isArray(blocks) || !blocks.length) return [];

	const items = [];
	for (const block of blocks) {
		const parts = [];
		collectPortableTextStrings(block, parts);
		const plaintext = parts.join(" ").replace(WHITESPACE_PATTERN, " ").trim();
		if (!plaintext) continue;
		items.push({
			$type: "blog.afterword.block.text",
			plaintext,
		});
	}

	return items;
}

function deriveTextContent(content) {
	const portableText = portableTextToPlainText(getPortableTextBlocks(content));
	if (portableText) return portableText;

	const source =
		contentValue(content, "textContent") ||
		contentValue(content, "body") ||
		contentValue(content, "content") ||
		contentValue(content, "text") ||
		contentValue(content, "excerpt") ||
		contentValue(content, "description");
	if (!source) return null;

	const normalized = decodeHtml(source).replace(HTML_TAG_PATTERN, " ").replace(WHITESPACE_PATTERN, " ").trim();
	if (!normalized) return null;
	return normalized.slice(0, MAX_TEXT_CONTENT_LENGTH);
}

function deriveContentPath(collection, content) {
	const slug = contentValue(content, "slug");
	if (!slug) return null;
	return collection === "pages" ? `/${slug}` : `/${collection}/${slug}`;
}

function extractEntryHtml(html) {
	const match = html.match(ENTRY_CONTENT_PATTERN);
	return trimString(match?.[1] ?? null);
}

function stripHtmlToText(html) {
	if (!html) return null;
	const normalized = decodeHtml(html)
		.replace(BR_PATTERN, " ")
		.replace(HTML_TAG_PATTERN, " ")
		.replace(WHITESPACE_PATTERN, " ")
		.trim();
	return normalized ? normalized.slice(0, MAX_TEXT_CONTENT_LENGTH) : null;
}

function extractPlaintextItems(html) {
	if (!html) return [];

	const items = [];
	for (const match of html.matchAll(PARAGRAPH_PATTERN)) {
		const text = stripHtmlToText(match[2]);
		if (!text) continue;
		items.push({
			$type: "blog.afterword.block.text",
			plaintext: text,
		});
	}

	if (items.length) return items;

	const fallback = stripHtmlToText(html);
	return fallback
		? [
				{
					$type: "blog.afterword.block.text",
					plaintext: fallback,
				},
		  ]
		: [];
}

function buildAfterwordContentPayload(snapshot, fallbackText = null, blocks = null) {
	const items = snapshot?.entryHtml
		? extractPlaintextItems(snapshot.entryHtml)
		: portableTextToItems(blocks).length
			? portableTextToItems(blocks)
			: fallbackText
				? [{ $type: "blog.afterword.block.text", plaintext: fallbackText }]
				: [];
	if (!items.length) return null;

	return {
		$type: "blog.afterword.content",
		items,
		...(snapshot?.entryHtml ? { html: snapshot.entryHtml } : {}),
	};
}

async function supportsSyndicatedCollection(ctx, collection) {
	const configured = trimString(await ctx.kv.get("settings:collections"));
	const allowed = configured
		? configured
				.split(",")
				.map((value) => value.trim().toLowerCase())
				.filter(Boolean)
		: ["posts"];
	return allowed.includes(String(collection || "").trim().toLowerCase());
}

function applyCanonicalSnapshot(content, snapshot) {
	if (!snapshot || !content || typeof content !== "object" || Array.isArray(content)) {
		return content;
	}

	const data =
		typeof content.data === "object" && content.data && !Array.isArray(content.data) ? content.data : null;
	const body = snapshot.textContent ?? null;
	const standardSiteContent = buildAfterwordContentPayload(snapshot, body, getPortableTextBlocks(content));
	const coverImage = snapshot.coverImageUrl ?? null;

	return {
		...content,
		...(body ? { body } : {}),
		...(coverImage ? { cover_image: content.cover_image ?? coverImage } : {}),
		...(standardSiteContent ? { standard_site_content: standardSiteContent } : {}),
		...(data
			? {
					data: {
						...data,
						...(body ? { body: data.body ?? body } : {}),
						...(coverImage ? { cover_image: data.cover_image ?? coverImage } : {}),
						...(standardSiteContent
							? { standard_site_content: data.standard_site_content ?? standardSiteContent }
							: {}),
					},
			  }
			: {}),
	};
}

function normalizePdsHost(value) {
	const raw = trimString(value) ?? "bsky.social";
	const candidate = ABSOLUTE_URL_PATTERN.test(raw) ? raw : `https://${raw}`;
	let url;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error(`Invalid PDS host: ${raw}`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`Invalid PDS host protocol: ${url.protocol}`);
	}
	return url.host;
}

function xrpcUrl(pdsHost, method) {
	return `https://${normalizePdsHost(pdsHost)}/xrpc/${method}`;
}

async function pluginFetch(ctx, input, init) {
	const http = ctx.http;
	if (!http?.fetch) {
		throw new Error("AT Protocol plugin requires the network:request capability");
	}
	return http.fetch(input, init);
}

async function responseNeedsRefresh(response) {
	if (response.status === 401) return true;
	if (response.status !== 400) return false;
	try {
		const body = await response.clone().json();
		return body?.error === "ExpiredToken";
	} catch {
		return false;
	}
}

async function parseJson(response, label) {
	let body;
	try {
		body = await response.json();
	} catch {
		throw new Error(`${label}: invalid JSON response`);
	}
	if (!body || typeof body !== "object") {
		throw new Error(`${label}: malformed response`);
	}
	return body;
}

function requireStringField(body, key, label) {
	const value = body?.[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`${label}: missing or invalid '${key}' in response`);
	}
	return value;
}

async function createSession(ctx, pdsHost, identifier, password) {
	const response = await pluginFetch(ctx, xrpcUrl(pdsHost, "com.atproto.server.createSession"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`createSession failed (${response.status}): ${text}`);
	}
	const body = await parseJson(response, "createSession");
	return {
		accessJwt: requireStringField(body, "accessJwt", "createSession"),
		refreshJwt: requireStringField(body, "refreshJwt", "createSession"),
		did: requireStringField(body, "did", "createSession"),
		handle: requireStringField(body, "handle", "createSession"),
	};
}

async function refreshSession(ctx, pdsHost, refreshJwt) {
	const response = await pluginFetch(ctx, xrpcUrl(pdsHost, "com.atproto.server.refreshSession"), {
		method: "POST",
		headers: { Authorization: `Bearer ${refreshJwt}` },
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`refreshSession failed (${response.status}): ${text}`);
	}
	const body = await parseJson(response, "refreshSession");
	return {
		accessJwt: requireStringField(body, "accessJwt", "refreshSession"),
		refreshJwt: requireStringField(body, "refreshJwt", "refreshSession"),
		did: requireStringField(body, "did", "refreshSession"),
		handle: requireStringField(body, "handle", "refreshSession"),
	};
}

async function persistSession(ctx, session) {
	await ctx.kv.set("state:accessJwt", session.accessJwt);
	await ctx.kv.set("state:refreshJwt", session.refreshJwt);
	await ctx.kv.set("state:did", session.did);
}

let refreshPromise = null;

async function ensureAuth(ctx) {
	const pdsHost = normalizePdsHost(await ctx.kv.get("settings:pdsHost"));
	const handle = await ctx.kv.get("settings:handle");
	const appPassword = await ctx.kv.get("settings:appPassword");
	if (!handle || !appPassword) {
		throw new Error("AT Protocol credentials not configured");
	}

	const accessJwt = await ctx.kv.get("state:accessJwt");
	const refreshJwt = await ctx.kv.get("state:refreshJwt");
	const did = await ctx.kv.get("state:did");
	if (accessJwt && did) {
		return { accessJwt, did, pdsHost };
	}

	if (refreshJwt) {
		refreshPromise ||= refreshSession(ctx, pdsHost, refreshJwt)
			.then(async (session) => {
				await persistSession(ctx, session);
				return session;
			})
			.finally(() => {
				refreshPromise = null;
			});
		try {
			const session = await refreshPromise;
			return { accessJwt: session.accessJwt, did: session.did, pdsHost };
		} catch {
			// Fall through to a full session creation attempt.
		}
	}

	const session = await createSession(ctx, pdsHost, handle, appPassword);
	await persistSession(ctx, session);
	return { accessJwt: session.accessJwt, did: session.did, pdsHost };
}

async function refreshAccess(ctx) {
	await ctx.kv.set("state:accessJwt", "");
	return ensureAuth(ctx);
}

async function uploadBlob(ctx, pdsHost, accessJwt, buffer, contentType) {
	const url = xrpcUrl(pdsHost, "com.atproto.repo.uploadBlob");
	let response = await pluginFetch(ctx, url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessJwt}`,
			"Content-Type": contentType,
		},
		body: buffer,
	});
	if (await responseNeedsRefresh(response)) {
		const refreshed = await refreshAccess(ctx);
		response = await pluginFetch(ctx, url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${refreshed.accessJwt}`,
				"Content-Type": contentType,
			},
			body: buffer,
		});
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`uploadBlob failed (${response.status}): ${text}`);
	}
	const body = await parseJson(response, "uploadBlob");
	if (!body.blob || typeof body.blob !== "object") {
		throw new Error("uploadBlob: missing 'blob' in response");
	}
	return body.blob;
}

function atUriRkey(atUri) {
	const rkey = atUri.split("/").at(-1);
	if (!rkey) {
		throw new Error(`Invalid AT-URI: ${atUri}`);
	}
	return rkey;
}

async function putRecord(ctx, pdsHost, accessJwt, did, collection, rkey, record) {
	const url = xrpcUrl(pdsHost, "com.atproto.repo.putRecord");
	let response = await pluginFetch(ctx, url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessJwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			repo: did,
			collection,
			rkey,
			record,
		}),
	});
	if (await responseNeedsRefresh(response)) {
		const refreshed = await refreshAccess(ctx);
		response = await pluginFetch(ctx, url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${refreshed.accessJwt}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				repo: refreshed.did,
				collection,
				rkey,
				record,
			}),
		});
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`putRecord failed (${response.status}): ${text}`);
	}
	const body = await parseJson(response, "putRecord");
	return {
		uri: requireStringField(body, "uri", "putRecord"),
		cid: requireStringField(body, "cid", "putRecord"),
	};
}

async function createRecord(ctx, pdsHost, accessJwt, did, collection, record) {
	const url = xrpcUrl(pdsHost, "com.atproto.repo.createRecord");
	let response = await pluginFetch(ctx, url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessJwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			repo: did,
			collection,
			record,
		}),
	});
	if (await responseNeedsRefresh(response)) {
		const refreshed = await refreshAccess(ctx);
		response = await pluginFetch(ctx, url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${refreshed.accessJwt}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				repo: refreshed.did,
				collection,
				record,
			}),
		});
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`createRecord failed (${response.status}): ${text}`);
	}
	const body = await parseJson(response, "createRecord");
	return {
		uri: requireStringField(body, "uri", "createRecord"),
		cid: requireStringField(body, "cid", "createRecord"),
	};
}

function decodeHtml(value) {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function extractMetaContent(html, attributeName, attributeValue) {
	const pattern = new RegExp(
		`<meta[^>]*${attributeName}=["']${attributeValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']+)["'][^>]*>`,
		"i",
	);
	const match = html.match(pattern);
	return trimString(match?.[1] ? decodeHtml(match[1]) : null);
}

function extractLinkHref(html, relValues) {
	for (const relValue of relValues) {
		const pattern = new RegExp(
			`<link[^>]*rel=["'][^"']*${relValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>`,
			"i",
		);
		const match = html.match(pattern);
		const href = trimString(match?.[1] ? decodeHtml(match[1]) : null);
		if (href) return href;
	}
	return null;
}

function absolutizeUrl(value, baseUrl) {
	if (!value) return null;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return null;
	}
}

async function fetchCanonicalSnapshot(ctx, collection, content) {
	const siteUrl = trimString(await ctx.kv.get("settings:siteUrl")) || trimString(ctx.site?.url);
	const path = deriveContentPath(collection, content);
	if (!siteUrl || !path) return null;

	const origins = [...new Set([siteUrl, ...(CANONICAL_FETCH_FALLBACKS[siteUrl] ?? [])].filter(Boolean))];
	for (const origin of origins) {
		let url;
		try {
			url = new URL(path, `${origin}/`);
		} catch {
			continue;
		}

		try {
			const response = await pluginFetch(ctx, url.toString());
			if (!response.ok) {
				ctx.log.warn(`Failed to fetch canonical page for standard.site enrichment (${response.status}) ${url}`);
				continue;
			}

			const html = await response.text();
			const entryHtml = extractEntryHtml(html);
			const textContent =
				stripHtmlToText(entryHtml) ||
				extractMetaContent(html, "name", "description") ||
				extractMetaContent(html, "property", "og:description");
			const coverImageUrl = absolutizeUrl(
				extractMetaContent(html, "property", "og:image") || extractMetaContent(html, "name", "twitter:image"),
				url.toString(),
			);

			return {
				url: url.toString(),
				entryHtml,
				textContent,
				coverImageUrl,
			};
		} catch (error) {
			ctx.log.warn(
				`Failed to fetch canonical page snapshot for ${collection}/${contentValue(content, "slug") ?? "unknown"} via ${origin}`,
				error,
			);
		}
	}

	return null;
}

async function fetchPublicationMetadata(ctx, siteUrl) {
	const response = await pluginFetch(ctx, siteUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch site metadata (${response.status})`);
	}
	const html = await response.text();
	return {
		description:
			extractMetaContent(html, "name", "description") ||
			extractMetaContent(html, "property", "og:description"),
		iconUrl: absolutizeUrl(
			extractLinkHref(html, ["apple-touch-icon", "icon", "shortcut icon"]),
			siteUrl,
		),
	};
}

async function buildPublicationIconBlob(ctx, iconUrl, pdsHost, accessJwt) {
	const candidates = Array.isArray(iconUrl) ? iconUrl : [iconUrl];
	for (const candidate of candidates) {
		if (!candidate) continue;

		try {
			const response = await pluginFetch(ctx, candidate);
			if (!response.ok) {
				ctx.log.warn(`Publication icon fetch failed (${response.status}) for ${candidate}`);
				continue;
			}
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > MAX_BLOB_BYTES) {
				ctx.log.warn(`Publication icon is larger than ${MAX_BLOB_BYTES} bytes; skipping icon upload`);
				continue;
			}
			return await uploadBlob(
				ctx,
				pdsHost,
				accessJwt,
				buffer,
				response.headers.get("content-type") || "image/jpeg",
			);
		} catch (error) {
			ctx.log.warn(`Failed to fetch or upload publication icon from ${candidate}`, error);
		}
	}
	return null;
}

async function getConfiguredPublicationIconUrls(ctx) {
	try {
		const settings = await getSiteSettings();
		const candidates = [settings.favicon?.url, settings.logo?.url].filter(
			(value) => typeof value === "string" && value.trim(),
		);
		if (candidates.length) {
			return candidates.map((value) => withOrigin(value.trim(), ctx.site?.url ?? ""));
		}
	} catch (error) {
		ctx.log.warn("Failed to load EmDash site settings for publication icon", error);
	}
	return [];
}

function isBlobLike(value) {
	return !!(
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		value.$type === "blob" &&
		value.ref &&
		typeof value.ref === "object"
	);
}

function normalizeSiteUrl(value) {
	return trimString(value)?.replace(/\/+$/, "") ?? null;
}

async function getExistingPublicationIcon(ctx, pdsHost, did, siteUrl) {
	const normalizedSiteUrl = normalizeSiteUrl(siteUrl);

	try {
		const recordsUrl = new URL(xrpcUrl(pdsHost, "com.atproto.repo.listRecords"));
		recordsUrl.searchParams.set("repo", did);
		recordsUrl.searchParams.set("collection", PUBLICATION_COLLECTION);
		recordsUrl.searchParams.set("limit", "20");
		const recordsResponse = await pluginFetch(ctx, recordsUrl.toString());
		if (recordsResponse.ok) {
			const body = await parseJson(recordsResponse, "listPublicationRecords");
			const records = Array.isArray(body.records) ? body.records : [];
			const exactMatch = records.find((entry) => {
				const recordUrl = normalizeSiteUrl(entry?.value?.url);
				return recordUrl && normalizedSiteUrl && recordUrl === normalizedSiteUrl && isBlobLike(entry?.value?.icon);
			});
			if (exactMatch?.value?.icon) return exactMatch.value.icon;

			const firstIcon = records.find((entry) => isBlobLike(entry?.value?.icon));
			if (firstIcon?.value?.icon) return firstIcon.value.icon;
		}
	} catch (error) {
		ctx.log.warn("Failed to reuse an existing publication icon", error);
	}

	try {
		const profileUrl = new URL(xrpcUrl(pdsHost, "com.atproto.repo.getRecord"));
		profileUrl.searchParams.set("repo", did);
		profileUrl.searchParams.set("collection", "app.bsky.actor.profile");
		profileUrl.searchParams.set("rkey", "self");
		const profileResponse = await pluginFetch(ctx, profileUrl.toString());
		if (!profileResponse.ok) return null;
		const body = await parseJson(profileResponse, "getProfileRecord");
		return isBlobLike(body?.value?.avatar) ? body.value.avatar : null;
	} catch (error) {
		ctx.log.warn("Failed to reuse profile avatar as publication icon", error);
		return null;
	}
}

async function buildPublicationRecord(ctx) {
	const siteUrl = trimString(await ctx.kv.get("settings:siteUrl"));
	const siteName = trimString(await ctx.kv.get("settings:siteName"));
	if (!siteUrl || !siteName) {
		return { error: "Site URL and name are required" };
	}

	let metadata = { description: null, iconUrl: null };
	try {
		metadata = await fetchPublicationMetadata(ctx, siteUrl);
	} catch (error) {
		ctx.log.warn("Failed to derive publication metadata from site HTML", error);
	}
	const configuredIconUrls = await getConfiguredPublicationIconUrls(ctx);
	if ((!metadata.iconUrl || !Array.isArray(metadata.iconUrl)) && configuredIconUrls.length) {
		metadata.iconUrl = metadata.iconUrl ? [metadata.iconUrl, ...configuredIconUrls] : configuredIconUrls;
	}
	if (!metadata.description || !metadata.iconUrl) {
		const fallback = PUBLICATION_METADATA_FALLBACKS[siteUrl];
		if (fallback) {
			metadata = {
				description: metadata.description ?? fallback.description,
				iconUrl: metadata.iconUrl
					? [
							...(Array.isArray(metadata.iconUrl) ? metadata.iconUrl : [metadata.iconUrl]),
							...(fallback.iconUrls ?? []),
					  ]
					: fallback.iconUrls ?? null,
				basicTheme: fallback.basicTheme ?? null,
			};
		}
	}

	const { accessJwt, did, pdsHost } = await ensureAuth(ctx);
	const iconBlob =
		(await buildPublicationIconBlob(ctx, metadata.iconUrl, pdsHost, accessJwt)) ||
		(await getExistingPublicationIcon(ctx, pdsHost, did, siteUrl));
	const record = {
		$type: PUBLICATION_COLLECTION,
		url: siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl,
		name: siteName,
		...(metadata.description ? { description: metadata.description } : {}),
		...(iconBlob ? { icon: iconBlob } : {}),
		...(metadata.basicTheme ? { basicTheme: metadata.basicTheme } : {}),
		preferences: { showInDiscover: true },
	};

	return { record, accessJwt, did, pdsHost };
}

function parseAtUri(atUri) {
	const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(atUri);
	if (!match) return null;
	return {
		repo: match[1],
		collection: match[2],
		rkey: match[3],
	};
}

function buildStrongRef(uri, cid) {
	if (!uri || !cid) return null;
	return {
		$type: "com.atproto.repo.strongRef",
		uri,
		cid,
	};
}

function stripTrailingPunctuation(value) {
	return value.replace(/[.,;:!?'"]+$/g, "");
}

function truncateGraphemes(value, maxLength) {
	const segments = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)];
	return segments.length <= maxLength
		? value
		: `${segments
				.slice(0, Math.max(0, maxLength - 1))
				.map((entry) => entry.segment)
				.join("")}…`;
}

function buildLinkFacets(text) {
	const facets = [];
	const encoder = new TextEncoder();
	const urlPattern = /https?:\/\/[^\s)>\]]+/g;

	let match;
	while ((match = urlPattern.exec(text)) !== null) {
		const uri = stripTrailingPunctuation(match[0]);
		const bytePrefix = encoder.encode(text.slice(0, match.index));
		const byteValue = encoder.encode(uri);
		facets.push({
			index: {
				byteStart: bytePrefix.length,
				byteEnd: bytePrefix.length + byteValue.length,
			},
			features: [{ $type: "app.bsky.richtext.facet#link", uri }],
		});
	}

	return facets;
}

function buildCrosspostText({ template, title, url, excerpt }) {
	return template
		.replace(/\{title\}/g, title)
		.replace(/\{url\}/g, url)
		.replace(/\{excerpt\}/g, excerpt);
}

async function buildCrosspostPayload(ctx, collection, content) {
	const siteUrl = trimString(await ctx.kv.get("settings:siteUrl"));
	if (!siteUrl) return null;

	const title = contentValue(content, "title") || "Untitled";
	const excerpt =
		contentValue(content, "excerpt") ||
		contentValue(content, "description") ||
		deriveTextContent(content) ||
		"";
	const path = deriveContentPath(collection, content);
	const url = path ? `${siteUrl.replace(/\/+$/, "")}${path}` : siteUrl;
	const template = trimString(await ctx.kv.get("settings:crosspostTemplate"));
	const text = truncateGraphemes(
		template ? buildCrosspostText({ template, title, url, excerpt }) : excerpt || title,
		300,
	);
	const langs = (trimString(await ctx.kv.get("settings:langs")) || "en")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.slice(0, 3);
	const description = truncateGraphemes(excerpt, 300);
	const facets = buildLinkFacets(text);

	return {
		url,
		title,
		description,
		text,
		langs,
		facets,
	};
}

function getImageStorageKey(image) {
	const value = normalizeObjectValue(image);
	if (!value) return null;
	const asset = typeof value.asset === "object" && value.asset ? value.asset : null;
	const meta = typeof value.meta === "object" && value.meta ? value.meta : null;

	if (typeof asset?._ref === "string" && asset._ref.trim()) {
		return asset._ref.trim();
	}

	if (typeof meta?.storageKey === "string" && meta.storageKey.trim()) {
		return meta.storageKey.trim();
	}

	if (typeof value.id === "string" && value.id.trim()) {
		return value.id.trim();
	}

	if (typeof value.src === "string" && value.src.includes(INTERNAL_MEDIA_PREFIX)) {
		const idx = value.src.indexOf(INTERNAL_MEDIA_PREFIX);
		const key = value.src.slice(idx + INTERNAL_MEDIA_PREFIX.length).split("?")[0];
		return key || null;
	}

	return null;
}

function getImageContentType(image) {
	const value = normalizeObjectValue(image);
	if (!value) return null;
	if (typeof value.contentType === "string" && value.contentType.trim()) return value.contentType.trim();
	if (typeof value.mimeType === "string" && value.mimeType.trim()) return value.mimeType.trim();
	const asset = typeof value.asset === "object" && value.asset ? value.asset : null;
	if (typeof asset?.mimeType === "string" && asset.mimeType.trim()) return asset.mimeType.trim();
	return null;
}

async function resolveFeaturedImageAsset(content, ctx) {
	const image = getFeaturedImageValue(content);
	if (!image) return null;

	let storageKey = getImageStorageKey(image);
	let contentType = getImageContentType(image);

	if (!storageKey || !env.MEDIA) return null;
	const object = await env.MEDIA.get(storageKey);
	if (!object || !("body" in object) || !object.body) return null;

	const buffer = await new Response(object.body).arrayBuffer();
	return {
		buffer,
		size: object.size ?? buffer.byteLength,
		contentType: contentType || object.httpMetadata?.contentType || "application/octet-stream",
	};
}

function flattenRgbaToRgb(data, background = { r: 30, g: 32, b: 33 }) {
	const out = new Uint8Array((data.length / 4) * 4);
	for (let i = 0; i < data.length; i += 4) {
		const alpha = data[i + 3] / 255;
		out[i] = Math.round(data[i] * alpha + background.r * (1 - alpha));
		out[i + 1] = Math.round(data[i + 1] * alpha + background.g * (1 - alpha));
		out[i + 2] = Math.round(data[i + 2] * alpha + background.b * (1 - alpha));
		out[i + 3] = 255;
	}
	return out;
}

function resizeRgbaNearest(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
	if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
		return source;
	}

	const out = new Uint8Array(targetWidth * targetHeight * 4);
	for (let y = 0; y < targetHeight; y += 1) {
		const sourceY = Math.min(sourceHeight - 1, Math.floor((y / targetHeight) * sourceHeight));
		for (let x = 0; x < targetWidth; x += 1) {
			const sourceX = Math.min(sourceWidth - 1, Math.floor((x / targetWidth) * sourceWidth));
			const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
			const targetIndex = (y * targetWidth + x) * 4;
			out[targetIndex] = source[sourceIndex];
			out[targetIndex + 1] = source[sourceIndex + 1];
			out[targetIndex + 2] = source[sourceIndex + 2];
			out[targetIndex + 3] = source[sourceIndex + 3];
		}
	}
	return out;
}

function decodeImageToRgba(buffer, contentType) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	if (/jpe?g/i.test(contentType)) {
		const decoded = jpeg.decode(bytes, { useTArray: true });
		return { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
	}
	if (/png/i.test(contentType)) {
		const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		const rgba = UPNG.toRGBA8(decoded)[0];
		return { data: new Uint8Array(rgba), width: decoded.width, height: decoded.height };
	}
	return null;
}

function encodeJpeg(data, width, height, quality) {
	const encoded = jpeg.encode({ data, width, height }, quality);
	return encoded.data instanceof Uint8Array ? encoded.data : new Uint8Array(encoded.data);
}

async function buildDocumentCoverBlob(ctx, content) {
	const asset = await resolveFeaturedImageAsset(content, ctx);
	if (!asset) return null;

	const { accessJwt, pdsHost } = await ensureAuth(ctx);
	if (asset.size <= MAX_BLOB_BYTES && /^image\//i.test(asset.contentType)) {
		return uploadBlob(ctx, pdsHost, accessJwt, asset.buffer, asset.contentType);
	}

	const decoded = decodeImageToRgba(asset.buffer, asset.contentType);
	if (!decoded) {
		ctx.log.warn(`Unsupported featured image type for cover export: ${asset.contentType}`);
		return null;
	}

	const baseScale = Math.min(1, MAX_COVER_WIDTH / decoded.width);
	const flattened = flattenRgbaToRgb(decoded.data);
	for (const scaleStep of COVER_SCALE_STEPS) {
		const width = Math.max(1, Math.round(decoded.width * baseScale * scaleStep));
		const height = Math.max(1, Math.round(decoded.height * baseScale * scaleStep));
		const resized = resizeRgbaNearest(flattened, decoded.width, decoded.height, width, height);

		for (const quality of COVER_JPEG_QUALITIES) {
			const encoded = encodeJpeg(resized, width, height, quality);
			if (encoded.byteLength <= MAX_BLOB_BYTES) {
				return uploadBlob(ctx, pdsHost, accessJwt, encoded, "image/jpeg");
			}
		}
	}

	ctx.log.warn("Unable to shrink featured image under the ATProto cover-image size limit");
	return null;
}

async function hydrateContentForCover(collection, content, ctx) {
	if (getFeaturedImageValue(content)) return content;

	const contentId = trimString(content?.id) || trimString(content?.data?.id) || String(content?.id ?? "");
	if (!contentId || !ctx.content?.get) return content;

	try {
		const stored = await ctx.content.get(collection, contentId);
		if (!stored) {
			ctx.log.info(`Could not load canonical content record for ${collection}/${contentId}`);
			return content;
		}

		return {
			...stored,
			...content,
			data: {
				...(stored.data && typeof stored.data === "object" && !Array.isArray(stored.data) ? stored.data : {}),
				...(content.data && typeof content.data === "object" && !Array.isArray(content.data) ? content.data : {}),
			},
		};
	} catch (error) {
		ctx.log.warn(`Failed to hydrate canonical content for ${collection}/${contentId}`, error);
		return content;
	}
}

async function resolveStrongRef(ctx, atUri, fallbackCid = null) {
	if (!atUri) return null;
	if (fallbackCid) return buildStrongRef(atUri, fallbackCid);

	const parsed = parseAtUri(atUri);
	if (!parsed) return null;

	const { pdsHost } = await ensureAuth(ctx);
	const url = new URL(xrpcUrl(pdsHost, "com.atproto.repo.getRecord"));
	url.searchParams.set("repo", parsed.repo);
	url.searchParams.set("collection", parsed.collection);
	url.searchParams.set("rkey", parsed.rkey);

	const response = await pluginFetch(ctx, url.toString());
	if (!response.ok) return null;
	const body = await parseJson(response, "getStrongRefRecord");
	return buildStrongRef(atUri, trimString(body?.cid));
}

function normalizeAssociatedRefs(value) {
	return Array.isArray(value)
		? value
				.map((entry) => ({
					$type: "com.atproto.repo.strongRef",
					uri: trimString(entry?.uri),
					cid: trimString(entry?.cid),
				}))
				.filter((entry) => entry.uri && entry.cid)
		: [];
}

async function patchCrosspostExternal(ctx, postUri, options = {}) {
	const { coverBlob = null, documentRef = null, publicationRef = null, payload = null } = options;
	const parsed = parseAtUri(postUri);
	if (!parsed) return null;

	const { accessJwt, did, pdsHost } = await ensureAuth(ctx);
	const url = new URL(xrpcUrl(pdsHost, "com.atproto.repo.getRecord"));
	url.searchParams.set("repo", parsed.repo);
	url.searchParams.set("collection", parsed.collection);
	url.searchParams.set("rkey", parsed.rkey);

	const response = await pluginFetch(ctx, url.toString());
	if (!response.ok) {
		ctx.log.warn(`Failed to fetch synced Bluesky post for external patch (${response.status})`);
		return { missing: true };
	}

	const body = await parseJson(response, "getBskyPostRecord");
	const record = body?.value;
	if (!record || typeof record !== "object") return null;

	const embed = record.embed;
	if (!embed || typeof embed !== "object" || embed.$type !== "app.bsky.embed.external") {
		return null;
	}

	const external = embed.external;
	if (!external || typeof external !== "object") return null;

	const nextExternal = { ...external };
	let changed = false;
	const nextRecord = { ...record };

	if (coverBlob) {
		const existingRef = external.thumb?.ref?.$link;
		const nextRef = coverBlob.ref?.$link;
		if (!existingRef || !nextRef || existingRef !== nextRef) {
			nextExternal.thumb = coverBlob;
			changed = true;
		}
	}

	const nextAssociatedRefs = [documentRef, publicationRef].filter(Boolean);
	if (nextAssociatedRefs.length) {
		const existingAssociatedRefs = normalizeAssociatedRefs(external.associatedRefs);
		if (JSON.stringify(existingAssociatedRefs) !== JSON.stringify(nextAssociatedRefs)) {
			nextExternal.associatedRefs = nextAssociatedRefs;
			changed = true;
		}
	}

	if (payload?.text && payload.text !== record.text) {
		nextRecord.text = payload.text;
		changed = true;
	}

	const nextFacets = payload?.facets?.length ? payload.facets : undefined;
	if (JSON.stringify(record.facets ?? []) !== JSON.stringify(nextFacets ?? [])) {
		if (nextFacets?.length) {
			nextRecord.facets = nextFacets;
		} else {
			delete nextRecord.facets;
		}
		changed = true;
	}

	if (payload?.langs?.length && JSON.stringify(record.langs ?? []) !== JSON.stringify(payload.langs)) {
		nextRecord.langs = payload.langs;
		changed = true;
	}

	if (!changed) {
		return { uri: postUri, cid: body?.cid ?? null };
	}

	return putRecord(ctx, pdsHost, accessJwt, did, parsed.collection, parsed.rkey, {
		...nextRecord,
		embed: {
			...embed,
			external: nextExternal,
		},
	});
}

async function createCrosspostRecord(ctx, collection, content, options = {}) {
	const { coverBlob = null, documentRef = null, publicationRef = null } = options;
	const { accessJwt, did, pdsHost } = await ensureAuth(ctx);
	const payload = await buildCrosspostPayload(ctx, collection, content);
	if (!payload) return null;

	const external = {
		uri: payload.url,
		title: payload.title,
		description: payload.description,
		...(coverBlob ? { thumb: coverBlob } : {}),
		associatedRefs: [documentRef, publicationRef].filter(Boolean),
	};

	const record = {
		$type: "app.bsky.feed.post",
		text: payload.text,
		createdAt: new Date().toISOString(),
		...(payload.langs.length ? { langs: payload.langs } : {}),
		embed: {
			$type: "app.bsky.embed.external",
			external,
		},
	};

	if (payload.facets.length) record.facets = payload.facets;

	return createRecord(ctx, pdsHost, accessJwt, did, "app.bsky.feed.post", record);
}

function getStandardSiteContent(content) {
	return (
		normalizeObjectValue(content?.standard_site_content) ??
		normalizeObjectValue(contentData(content)?.standard_site_content) ??
		null
	);
}

function documentNeedsRepair(record) {
	if (!record || typeof record !== "object") return false;
	return !record.coverImage || !record.textContent || !record.content;
}

async function patchSyncedDocumentRecord(event, ctx, options = {}) {
	const { includeCover = true, includeThumb = true, allowCreateCrosspost = false } = options;
	const collection = trimString(event?.collection);
	let content = event?.content;
	if (!collection || !content || typeof content !== "object") return;

	content = await hydrateContentForCover(collection, content, ctx);

	const contentId = trimString(content.id) || trimString(content.data?.id) || String(content.id ?? "");
	if (!contentId) return;

	const synced = await ctx.storage.records.get(`${collection}:${contentId}`);
	if (!synced?.atUri || synced.status !== "synced") {
		ctx.log.info(`No synced ATProto document record found for ${collection}/${contentId}`);
		return;
	}

	const parsed = parseAtUri(synced.atUri);
	if (!parsed) return;

	const { accessJwt, did, pdsHost } = await ensureAuth(ctx);
	const url = new URL(xrpcUrl(pdsHost, "com.atproto.repo.getRecord"));
	url.searchParams.set("repo", parsed.repo);
	url.searchParams.set("collection", parsed.collection);
	url.searchParams.set("rkey", parsed.rkey);

	const response = await pluginFetch(ctx, url.toString());
	if (!response.ok) {
		ctx.log.warn(`Failed to fetch synced document record for cover patch (${response.status})`);
		return;
	}

	const body = await parseJson(response, "getDocumentRecord");
	const record = body?.value;
	if (!record || typeof record !== "object") return;

	const nextRecord = { ...record };
	let shouldUpdateRecord = false;

	const textContent = deriveTextContent(content);
	if (textContent && textContent !== record.textContent) {
		nextRecord.textContent = textContent;
		shouldUpdateRecord = true;
	}

	const tags = normalizeTags(content);
	if (tags.length) {
		const existingTags = Array.isArray(record.tags) ? record.tags : [];
		if (JSON.stringify(existingTags) !== JSON.stringify(tags)) {
			nextRecord.tags = tags;
			shouldUpdateRecord = true;
		}
	}

	const standardSiteContent =
		getStandardSiteContent(content) ||
		buildAfterwordContentPayload(
			null,
			textContent || trimString(record.textContent) || trimString(record.description),
			getPortableTextBlocks(content),
		);
	if (standardSiteContent) {
		const existingContent = JSON.stringify(record.content ?? null);
		const nextContent = JSON.stringify(standardSiteContent);
		if (existingContent !== nextContent) {
			nextRecord.content = standardSiteContent;
			shouldUpdateRecord = true;
		}
	}

	const coverBlob = includeCover && !record.coverImage ? await buildDocumentCoverBlob(ctx, content) : null;
	if (coverBlob) {
		const existingRef = record.coverImage?.ref?.$link;
		const nextRef = coverBlob.ref?.$link;
		if (!existingRef || !nextRef || existingRef !== nextRef) {
			nextRecord.coverImage = coverBlob;
			shouldUpdateRecord = true;
		}
	} else {
		if (includeCover) {
			ctx.log.info(`No cover blob generated for ${collection}/${contentId}`);
		}
	}

	let workingRecord = shouldUpdateRecord ? nextRecord : record;
	let workingCid = trimString(body?.cid);
	if (shouldUpdateRecord) {
		const updatedDocument = await putRecord(ctx, pdsHost, accessJwt, did, DOCUMENT_COLLECTION, parsed.rkey, nextRecord);
		workingCid = updatedDocument.cid;
		workingRecord = { ...nextRecord };
		await ctx.storage.records.put(`${collection}:${contentId}`, {
			...synced,
			atCid: updatedDocument.cid,
			lastSyncedAt: new Date().toISOString(),
			status: "synced",
		});
	}

	const documentRef = buildStrongRef(synced.atUri, workingCid);
	const bskyPostUri = trimString(workingRecord.bskyPostRef?.uri) || trimString(synced.bskyPostUri);
	const publicationUri = trimString(workingRecord.site) || trimString(await ctx.kv.get("state:publicationUri"));
	if (bskyPostUri || publicationUri) {
		const crosspostPayload = await buildCrosspostPayload(ctx, collection, content);
		const publicationCid =
			(publicationUri && publicationUri === trimString(await ctx.kv.get("state:publicationUri"))
				? trimString(await ctx.kv.get("state:publicationCid"))
				: null) || null;
		const publicationRef = publicationUri ? await resolveStrongRef(ctx, publicationUri, publicationCid) : null;
		let updatedPost = null;
		if (bskyPostUri) {
			updatedPost = await patchCrosspostExternal(ctx, bskyPostUri, {
				coverBlob: includeThumb ? coverBlob : null,
				documentRef,
				publicationRef,
				payload: crosspostPayload,
			});
		}
		if ((!updatedPost || updatedPost.missing) && allowCreateCrosspost) {
			updatedPost = await createCrosspostRecord(ctx, collection, content, {
				coverBlob: includeThumb ? coverBlob : null,
				documentRef,
				publicationRef,
			});
		} else if ((!updatedPost || updatedPost.missing) && !allowCreateCrosspost) {
			ctx.log.info(`Skipping crosspost creation during repair for ${collection}/${contentId}`);
		}
		if (updatedPost?.uri && updatedPost?.cid) {
			const existingPostCid = trimString(workingRecord.bskyPostRef?.cid);
			if (existingPostCid !== updatedPost.cid || workingRecord.bskyPostRef?.uri !== updatedPost.uri) {
				workingRecord = {
					...workingRecord,
					bskyPostRef: { uri: updatedPost.uri, cid: updatedPost.cid },
				};
				const finalDocument = await putRecord(
					ctx,
					pdsHost,
					accessJwt,
					did,
					DOCUMENT_COLLECTION,
					parsed.rkey,
					workingRecord,
				);
				workingCid = finalDocument.cid;
				await ctx.storage.records.put(`${collection}:${contentId}`, {
					...synced,
					atCid: finalDocument.cid,
					bskyPostUri: updatedPost.uri,
					bskyPostCid: updatedPost.cid,
					lastSyncedAt: new Date().toISOString(),
					status: "synced",
				});
				ctx.log.info(`Patched site.standard.document metadata for ${collection}/${contentId}`);
				return;
			}
		}
	}

	if (!shouldUpdateRecord) return;
	ctx.log.info(`Patched site.standard.document metadata for ${collection}/${contentId}`);
}

async function publicationNeedsRefresh(ctx) {
	const publicationUri = trimString(await ctx.kv.get("state:publicationUri"));
	if (!publicationUri) return true;

	const parsed = parseAtUri(publicationUri);
	const pdsHost = normalizePdsHost(await ctx.kv.get("settings:pdsHost"));
	if (!parsed) return true;

	try {
		const url = new URL(xrpcUrl(pdsHost, "com.atproto.repo.getRecord"));
		url.searchParams.set("repo", parsed.repo);
		url.searchParams.set("collection", parsed.collection);
		url.searchParams.set("rkey", parsed.rkey);
		const response = await pluginFetch(ctx, url.toString());
		if (!response.ok) return true;
		const body = await parseJson(response, "getRecord");
		const value = body?.value;
		return !(
			value &&
			typeof value === "object" &&
			typeof value.description === "string" &&
			value.description.trim() &&
			value.icon &&
			value.basicTheme
		);
	} catch (error) {
		ctx.log.warn("Failed to inspect current publication record", error);
		return true;
	}
}

async function syncPublication(ctx) {
	const built = await buildPublicationRecord(ctx);
	if ("error" in built) {
		return { success: false, error: built.error };
	}

	const publicationUri = await ctx.kv.get("state:publicationUri");
	const result = publicationUri
		? await putRecord(
				ctx,
				built.pdsHost,
				built.accessJwt,
				built.did,
				PUBLICATION_COLLECTION,
				atUriRkey(publicationUri),
				built.record,
			)
		: await createRecord(ctx, built.pdsHost, built.accessJwt, built.did, PUBLICATION_COLLECTION, built.record);

	await ctx.kv.set("state:publicationUri", result.uri);
	await ctx.kv.set("state:publicationCid", result.cid);
	await ctx.kv.set(PUBLICATION_REFRESH_KEY, new Date().toISOString());
	return { success: true, uri: result.uri, cid: result.cid };
}

async function maybeRefreshPublication(ctx) {
	const lastRefreshed = trimString(await ctx.kv.get(PUBLICATION_REFRESH_KEY));
	const needsRefresh = await publicationNeedsRefresh(ctx);
	if (lastRefreshed) {
		const refreshedAt = Date.parse(lastRefreshed);
		if (!needsRefresh && Number.isFinite(refreshedAt) && Date.now() - refreshedAt < PUBLICATION_REFRESH_INTERVAL_MS) {
			ctx.log.info(`Skipping publication refresh; last sync at ${lastRefreshed}`);
			return;
		}
	}

	try {
		ctx.log.info("Refreshing site.standard.publication metadata");
		await syncPublication(ctx);
		ctx.log.info("Refreshed site.standard.publication metadata");
	} catch (error) {
		ctx.log.warn("Failed to refresh publication metadata during page render", error);
		await ctx.kv.set(PUBLICATION_REFRESH_KEY, new Date().toISOString());
	}
}

async function shouldAttemptDocumentRepair(pageContent, ctx) {
	const collection = trimString(pageContent?.collection);
	const contentId = trimString(pageContent?.id);
	if (!collection || !contentId) return false;
	if (!(await supportsSyndicatedCollection(ctx, collection))) return false;

	const cooldownKey = `${DOCUMENT_REPAIR_PREFIX}${collection}:${contentId}`;
	const lastAttempt = trimString(await ctx.kv.get(cooldownKey));
	if (lastAttempt) {
		const elapsed = Date.now() - Date.parse(lastAttempt);
		if (Number.isFinite(elapsed) && elapsed < DOCUMENT_REPAIR_COOLDOWN_MS) {
			return false;
		}
	}

	const synced = await ctx.storage.records.get(`${collection}:${contentId}`);
	if (!synced?.atUri || synced.status !== "synced") return false;

	const parsed = parseAtUri(synced.atUri);
	if (!parsed) return false;

	const { pdsHost } = await ensureAuth(ctx);
	const url = new URL(xrpcUrl(pdsHost, "com.atproto.repo.getRecord"));
	url.searchParams.set("repo", parsed.repo);
	url.searchParams.set("collection", parsed.collection);
	url.searchParams.set("rkey", parsed.rkey);

	const response = await pluginFetch(ctx, url.toString());
	if (!response.ok) return false;
	const body = await parseJson(response, "getRecordForRepairCheck");
	if (documentNeedsRepair(body?.value)) return true;

	const bskyPostUri =
		trimString(body?.value?.bskyPostRef?.uri) || trimString(synced.bskyPostUri);
	if (!bskyPostUri) return false;

	const post = parseAtUri(bskyPostUri);
	if (!post) return false;
	const postUrl = new URL(xrpcUrl(pdsHost, "com.atproto.repo.getRecord"));
	postUrl.searchParams.set("repo", post.repo);
	postUrl.searchParams.set("collection", post.collection);
	postUrl.searchParams.set("rkey", post.rkey);
	const postResponse = await pluginFetch(ctx, postUrl.toString());
	if (!postResponse.ok) return true;
	const postBody = await parseJson(postResponse, "getCrosspostForRepairCheck");
	const external = postBody?.value?.embed?.external;
	if (!external || typeof external !== "object") return false;
	return normalizeAssociatedRefs(external.associatedRefs).length < 2;
}

async function handleAdmin(input, ctx) {
	const type = input?.type ?? "page_load";
	const actionId = input?.action_id ?? null;

	if (type === "block_action" && actionId === "sync_publication") {
		try {
			const result = await syncPublication(ctx);
			const refreshed = await base.routes.admin.handler({ type: "page_load", page: "/settings" }, ctx);
			return {
				...refreshed,
				toast: result.success
					? { message: "Publication synced", type: "success" }
					: { message: result.error ?? "Failed to sync publication", type: "error" },
			};
		} catch (error) {
			const refreshed = await base.routes.admin.handler({ type: "page_load", page: "/settings" }, ctx);
			return {
				...refreshed,
				toast: {
					message: `Publication sync failed: ${error instanceof Error ? error.message : "Unknown error"}`,
					type: "error",
				},
			};
		}
	}

	return base.routes.admin.handler(input, ctx);
}

async function handlePageMetadata(event, ctx) {
	const handler = getHookHandler(base?.hooks?.["page:metadata"]);
	return handler ? handler(event, ctx) : null;
}

export default {
	...base,
	hooks: {
		...(base.hooks || {}),
		"content:afterSave": wrapHook(base?.hooks?.["content:afterSave"]),
		"content:afterPublish": wrapContentHook(base?.hooks?.["content:afterPublish"], {
			includeCover: true,
			includeThumb: true,
			allowCreateCrosspost: true,
		}),
		"page:metadata": handlePageMetadata,
	},
	routes: {
		...(base.routes || {}),
		"sync-publication": {
			...(base.routes?.["sync-publication"] || {}),
			handler: async (_input, ctx) => {
				try {
					return await syncPublication(ctx);
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},
		"repair-document": {
			handler: async ({ input }, ctx) => {
				try {
					const collection = trimString(input?.collection);
					const contentId = trimString(input?.contentId);
					if (!collection || !contentId) {
						return { success: false, error: "collection and contentId are required" };
					}
					if (!ctx.content?.get) {
						return { success: false, error: "content loader unavailable" };
					}
					const content = await ctx.content.get(collection, contentId);
					if (!content) {
						return { success: false, error: `content not found for ${collection}/${contentId}` };
					}
					await patchSyncedDocumentRecord(
						{ collection, content },
						ctx,
						{ includeCover: true, includeThumb: true, allowCreateCrosspost: false },
					);
					return { success: true, collection, contentId };
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},
		admin: {
			...(base.routes?.admin || {}),
			handler: handleAdmin,
		},
	},
};
