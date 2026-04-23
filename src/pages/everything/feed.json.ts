import type { APIRoute } from "astro";
import { getEverythingFeedItems, getFeedMetadata, jsonFeedResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site?.toString().replace(/\/$/, "") || url.origin;
	const items = await getEverythingFeedItems(site, url);
	const meta = getFeedMetadata();
	return jsonFeedResponse({
		siteUrl,
		path: "/everything/feed.json",
		title: meta.siteTitle,
		description: meta.siteDescription,
		items,
	});
};
