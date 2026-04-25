import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getCheckinsPage } from "../../lib/checkins";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
	const limit = Number.parseInt(url.searchParams.get("limit") || "", 10);
	const cursor = url.searchParams.get("cursor");
	const page = await getCheckinsPage(env as unknown as Record<string, unknown>, {
		limit: Number.isFinite(limit) ? limit : 20,
		cursor,
	});

	return new Response(JSON.stringify(page), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
		},
	});
};
