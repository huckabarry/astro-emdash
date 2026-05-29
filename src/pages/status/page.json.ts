import type { APIRoute } from "astro";
import { getStatusFeedPage } from "../../lib/status-feed";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
	const cursor = String(url.searchParams.get("cursor") || "").trim() || null;
	const limitValue = Number.parseInt(String(url.searchParams.get("limit") || "20"), 10);
	const limit = Number.isFinite(limitValue) ? limitValue : 20;
	const page = await getStatusFeedPage({ cursor, limit, includeReplies: false });

	return new Response(JSON.stringify(page), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=60, s-maxage=240, stale-while-revalidate=600",
		},
	});
};
