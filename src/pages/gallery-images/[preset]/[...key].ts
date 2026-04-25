import type { APIContext, APIRoute } from "astro";

export const prerender = false;

const PRESETS = {
	"thumb-sm": { width: 360, quality: 70 },
	"thumb-md": { width: 720, quality: 74 },
	thumb: { width: 1080, quality: 78 },
	large: { width: 1800, quality: 82 },
} as const;

const ALLOWED_HOSTS = new Set([
	"lowvelocity.org",
	"www.lowvelocity.org",
	"afterword.blog",
	"www.afterword.blog",
]);

async function fetchGalleryImage(sourceUrl: URL, preset: (typeof PRESETS)[keyof typeof PRESETS]) {
	const headers = {
		Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
	};

	const transformed = await fetch(sourceUrl.toString(), {
		headers,
		cf: {
			image: {
				width: preset.width,
				quality: preset.quality,
				format: "auto",
				fit: "scale-down",
				metadata: "none",
			},
		},
	} as unknown as RequestInit);

	if (transformed.ok && transformed.body) {
		return transformed;
	}

	return fetch(sourceUrl.toString(), { headers });
}

async function handle(context: APIContext, includeBody: boolean) {
	const { params, request } = context;
	const preset = params.preset as keyof typeof PRESETS | undefined;
	if (!preset || !(preset in PRESETS)) {
		return new Response("Unknown gallery preset.", { status: 404 });
	}

	const requestUrl = new URL(request.url);
	const source = requestUrl.searchParams.get("src");
	if (!source) {
		return new Response("Missing gallery source.", { status: 400 });
	}

	let sourceUrl: URL;
	try {
		sourceUrl = new URL(source);
	} catch {
		return new Response("Invalid gallery source.", { status: 400 });
	}

	const isSameOrigin = sourceUrl.origin === requestUrl.origin;
	if (sourceUrl.protocol !== "https:" || (!ALLOWED_HOSTS.has(sourceUrl.hostname) && !isSameOrigin)) {
		return new Response("Gallery source not allowed.", { status: 403 });
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

	const presetOptions = PRESETS[preset];
	const upstream = await fetchGalleryImage(sourceUrl, presetOptions);

	if (!upstream.ok || !upstream.body) {
		return new Response("Unable to load gallery image.", {
			status: upstream.status || 502,
		});
	}

	const headers = new Headers();
	const contentType = upstream.headers.get("content-type");
	if (contentType) headers.set("content-type", contentType);
	headers.set("cache-control", "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800");
	headers.set("x-robots-tag", "noindex");

	const response = new Response(upstream.body, {
		status: upstream.status,
		headers,
	});

	if (request.method === "GET") {
		await cache.put(request, response.clone());
	}

	return includeBody
		? response
		: new Response(null, {
				status: response.status,
				headers: response.headers,
			});
}

export const GET: APIRoute = async (context) => handle(context, true);

export const HEAD: APIRoute = async (context) => handle(context, false);
