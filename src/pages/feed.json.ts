import type { APIRoute } from "astro";
import { getWritingFeedItems, jsonResponse } from "../lib/feeds";

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getWritingFeedItems(site, url);
	return jsonResponse({ items });
};
