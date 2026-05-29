import type { APIRoute } from "astro";
import { getFeedMetadata, getPlanningFeedItems, jsonFeedResponse } from "../../lib/feeds";

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site?.toString().replace(/\/$/, "") || url.origin;
	const items = await getPlanningFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();
	return jsonFeedResponse({
		siteUrl,
		path: "/planning/feed.json",
		title: `${siteTitle} / Planning`,
		description: "Planning and urbanism posts only.",
		items,
	});
};
