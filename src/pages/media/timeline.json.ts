import type { APIRoute } from "astro";
import { getMediaTimelinePage } from "../../lib/media";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
	const offset = Number.parseInt(url.searchParams.get("offset") || "", 10);
	const limit = Number.parseInt(url.searchParams.get("limit") || "", 10);
	const page = await getMediaTimelinePage(
		Number.isFinite(offset) ? offset : 0,
		Number.isFinite(limit) ? limit : 8,
	);

	return new Response(JSON.stringify(page), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
		},
	});
};
