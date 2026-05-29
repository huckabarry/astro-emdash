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

function withOrigin(url, origin) {
	if (!url) return url;
	if (url.startsWith("http://") || url.startsWith("https://")) return url;
	if (url.startsWith("/")) return origin ? `${origin}${url}` : url;
	return url;
}

function getFeaturedImageUrl(image, origin = "") {
	if (!image || typeof image !== "object" || Array.isArray(image)) return null;

	const value = image;

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
	return content.featured_image ?? data?.featured_image ?? null;
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

function getHookHandler(entry) {
	if (!entry) return null;
	return typeof entry === "function" ? entry : entry.handler;
}

function wrapHook(entry) {
	const handler = getHookHandler(entry);
	if (!handler) return entry;

	const wrapped = async (event, ctx) => {
		const nextEvent =
			event && typeof event === "object" && "content" in event
				? { ...event, content: await enrichContent(event.content, ctx) }
				: event;
		return handler(nextEvent, ctx);
	};

	return typeof entry === "function" ? wrapped : { ...entry, handler: wrapped };
}

function wrapContentHook(entry) {
	const handler = getHookHandler(entry);
	if (!handler) return entry;

	const wrapped = async (event, ctx) => {
		const nextEvent =
			event && typeof event === "object" && "content" in event
				? { ...event, content: await enrichContent(event.content, ctx) }
				: event;
		const result = await handler(nextEvent, ctx);
		if (nextEvent && typeof nextEvent === "object" && "content" in nextEvent) {
			await patchSyncedDocumentCover(nextEvent, ctx);
		}
		return result;
	};

	return typeof entry === "function" ? wrapped : { ...entry, handler: wrapped };
}

function trimString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
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

function getImageStorageKey(image) {
	if (!image || typeof image !== "object" || Array.isArray(image)) return null;

	const value = image;
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
	if (!image || typeof image !== "object" || Array.isArray(image)) return null;
	const value = image;
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

async function patchSyncedDocumentCover(event, ctx) {
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

	const coverBlob = await buildDocumentCoverBlob(ctx, content);
	if (!coverBlob) {
		ctx.log.info(`No cover blob generated for ${collection}/${contentId}`);
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

	const existingRef = record.coverImage?.ref?.$link;
	const nextRef = coverBlob.ref?.$link;
	if (existingRef && nextRef && existingRef === nextRef) return;

	const result = await putRecord(ctx, pdsHost, accessJwt, did, DOCUMENT_COLLECTION, parsed.rkey, {
		...record,
		coverImage: coverBlob,
	});

	await ctx.storage.records.put(`${collection}:${contentId}`, {
		...synced,
		atCid: result.cid,
		lastSyncedAt: new Date().toISOString(),
		status: "synced",
	});
	ctx.log.info(`Patched site.standard.document cover image for ${collection}/${contentId}`);
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
	await maybeRefreshPublication(ctx);
	const content = event?.page?.content;
	if (content?.collection && content) {
		after(async () => {
			await patchSyncedDocumentCover({ collection: content.collection, content }, ctx);
		});
	}
	const handler = getHookHandler(base?.hooks?.["page:metadata"]);
	return handler ? handler(event, ctx) : null;
}

export default {
	...base,
	hooks: {
		...(base.hooks || {}),
		"content:afterSave": wrapContentHook(base?.hooks?.["content:afterSave"]),
		"content:afterPublish": wrapContentHook(base?.hooks?.["content:afterPublish"]),
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
		admin: {
			...(base.routes?.admin || {}),
			handler: handleAdmin,
		},
	},
};
