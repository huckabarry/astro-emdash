import type { APIRoute } from "astro";
import { getFeedMetadata, getWritingFeedItems, jsonFeedResponse } from "../lib/feeds";

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site?.toString().replace(/\/$/, "") || url.origin;
	const items = await getWritingFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();
	return jsonFeedResponse({
		siteUrl,
		path: "/feed.json",
		title: `${siteTitle} / Writing`,
		description: "Field notes, planning posts, and other longer writing from Afterword.",
		items,
	});
};
