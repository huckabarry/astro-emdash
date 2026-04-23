import type { APIRoute } from "astro";
import { getStatusFeedItems, jsonResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getStatusFeedItems(site, url);
	return jsonResponse({ items });
};
