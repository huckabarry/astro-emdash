import type { APIRoute } from "astro";
import { getFeedMetadata, getPlanningFeedItems, xmlFeedResponse } from "../../lib/feeds";

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getPlanningFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();

	return xmlFeedResponse({
		siteUrl: site?.toString().replace(/\/$/, "") || url.origin,
		path: "/planning/feed.xml",
		title: `${siteTitle} / Planning`,
		description: "Planning and urbanism posts only.",
		items,
	});
};
