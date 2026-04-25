import type { APIRoute } from "astro";

const ALLOWED_HOSTS = new Set([
	"afterword.blog",
	"www.afterword.blog",
	"lowvelocity.org",
	"www.lowvelocity.org",
]);

const SELF_HOSTS = new Set(["afterword.blog", "www.afterword.blog"]);

export const prerender = false;

function buildHeaders(upstream: Response) {
	const headers = new Headers();
	const contentType = upstream.headers.get("content-type");
	if (contentType) headers.set("content-type", contentType);

	const contentLength = upstream.headers.get("content-length");
	if (contentLength) headers.set("content-length", contentLength);

	const etag = upstream.headers.get("etag");
	if (etag) headers.set("etag", etag);

	const lastModified = upstream.headers.get("last-modified");
	if (lastModified) headers.set("last-modified", lastModified);

	headers.set("cache-control", "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800");
	headers.set("x-robots-tag", "noindex");
	return headers;
}

async function handle(request: Request, includeBody: boolean) {
	const requestUrl = new URL(request.url);
	const source = requestUrl.searchParams.get("src");
	if (!source) {
		return new Response("Missing source URL.", { status: 400 });
	}

	let sourceUrl: URL;
	try {
		sourceUrl = new URL(source);
	} catch {
		return new Response("Invalid source URL.", { status: 400 });
	}

	if (sourceUrl.protocol !== "https:" || !ALLOWED_HOSTS.has(sourceUrl.hostname)) {
		return new Response("Source not allowed.", { status: 403 });
	}

	// Avoid worker self-fetch recursion (which can trigger 522s on Cloudflare).
	// If the source is already on our own host, just redirect to it and let the
	// browser load the asset directly (these URLs already have long-lived caching).
	if (SELF_HOSTS.has(sourceUrl.hostname)) {
		const headers = new Headers({
			Location: sourceUrl.toString(),
			"cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
			"x-robots-tag": "noindex",
		});
		return new Response(null, { status: 302, headers });
	}

	const cache = (caches as CacheStorage & { default: Cache }).default;
	if (request.method === "GET") {
		const cached = await cache.match(request);
		if (cached) {
			return includeBody
				? cached
				: new Response(null, {
						status: cached.status,
						headers: cached.headers,
					});
		}
	}

	const upstream = await fetch(sourceUrl.toString(), {
		headers: {
			Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
		},
	});

	if (!upstream.ok) {
		return new Response("Unable to load legacy media.", {
			status: upstream.status || 502,
		});
	}

	const body = await upstream.arrayBuffer();
	const headers = buildHeaders(upstream);

	if (request.method === "GET") {
		await cache.put(
			request,
			new Response(body, {
				status: upstream.status,
				headers,
			}),
		);
	}

	return new Response(includeBody ? body : null, {
		status: upstream.status,
		headers,
	});
}

export const GET: APIRoute = async ({ request }) => handle(request, true);
export const HEAD: APIRoute = async ({ request }) => handle(request, false);
