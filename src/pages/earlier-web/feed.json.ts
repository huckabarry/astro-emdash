import type { APIRoute } from "astro";
import { getEarlierWebStreamHydratedPage } from "../../lib/earlier-web";

export const GET: APIRoute = async ({ url }) => {
	const cursor = url.searchParams.get("cursor") || undefined;
	const limit = Number.parseInt(url.searchParams.get("limit") || "", 10);
	const page = await getEarlierWebStreamHydratedPage({
		cursor,
		limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : undefined,
	});

	return new Response(JSON.stringify(page), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
		},
	});
};
