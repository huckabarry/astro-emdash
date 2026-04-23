import type { APIRoute } from "astro";
import { getFeedMetadata, getStatusFeedItems, xmlFeedResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getStatusFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();

	return xmlFeedResponse({
		siteUrl: site?.toString().replace(/\/$/, "") || url.origin,
		path: "/status/feed.xml",
		title: `${siteTitle} / Status`,
		description: "Short updates pulled from Bluesky into the site.",
		items,
	});
};
