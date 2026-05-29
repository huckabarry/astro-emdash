import type { APIRoute } from "astro";
import { getFeedMetadata, getStatusFeedItems, jsonFeedResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
	const siteUrl = url.origin;
	const items = await getStatusFeedItems(undefined, url);
	const { siteTitle } = getFeedMetadata();
	return jsonFeedResponse({
		siteUrl,
		path: "/status/feed.json",
		title: `${siteTitle} / Status`,
		description: "Short updates pulled from Bluesky into the site.",
		items,
	});
};
