import { env } from "cloudflare:workers";

function getLegacyBucket() {
	return env.LEGACY_MEDIA;
}

function toCandidateKeys(key: string | undefined, prefixes: string[]) {
	if (!key) return [];
	const normalized = key.replace(/^\/+/, "");
	const candidates = new Set([normalized]);
	for (const prefix of prefixes) {
		const cleanedPrefix = prefix.replace(/^\/+|\/+$/g, "");
		if (cleanedPrefix) {
			candidates.add(`${cleanedPrefix}/${normalized}`);
		}
	}
	return Array.from(candidates);
}

export async function serveLegacyAsset(
	key: string | undefined,
	options?: { notFoundLabel?: string; prefixes?: string[] },
) {
	const notFoundLabel = options?.notFoundLabel || "Asset";
	const candidates = toCandidateKeys(key, options?.prefixes || []);

	if (!candidates.length) {
		return new Response(`${notFoundLabel} not found`, { status: 404 });
	}

	const bucket = getLegacyBucket();
	if (!bucket) {
		return new Response("Legacy media storage is not configured", { status: 500 });
	}

	for (const candidate of candidates) {
		const object = await bucket.get(candidate);
		if (!object) continue;

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("etag", object.httpEtag);
		headers.set("cache-control", headers.get("cache-control") || "public, max-age=31536000, immutable");

		return new Response(object.body, { headers });
	}

	if (!key) {
		return new Response(`${notFoundLabel} not found`, { status: 404 });
	}
	
	return new Response(`${notFoundLabel} not found`, { status: 404 });
}
