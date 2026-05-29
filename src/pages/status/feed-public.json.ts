import type { APIRoute } from "astro";
import { getFeedMetadata, getStatusFeedItems, jsonFeedResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getStatusFeedItems(site, url);
	const siteUrl = site?.toString().replace(/\/$/, "") || url.origin;
	const { siteTitle } = getFeedMetadata();
	return jsonFeedResponse({
		siteUrl,
		path: "/status/feed-public.json",
		title: `${siteTitle} / Status`,
		description: "Short updates pulled from Bluesky into the site.",
		items,
	});
};
