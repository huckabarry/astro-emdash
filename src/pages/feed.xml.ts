import type { APIRoute } from "astro";
import { getFeedMetadata, getWritingFeedItems, xmlFeedResponse } from "../lib/feeds";

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getWritingFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();

	return xmlFeedResponse({
		siteUrl: site?.toString().replace(/\/$/, "") || url.origin,
		path: "/feed.xml",
		title: `${siteTitle} / Writing`,
		description: "Field notes, planning posts, and other longer writing from Afterword.",
		items,
	});
};
