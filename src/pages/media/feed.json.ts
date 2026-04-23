import type { APIRoute } from "astro";
import { getMediaFeedItems, jsonResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getMediaFeedItems(site, url);
	return jsonResponse({ items });
};
