import type { APIRoute } from "astro";
import { getPlanningFeedItems, jsonResponse } from "../../lib/feeds";

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getPlanningFeedItems(site, url);
	return jsonResponse({ items });
};
