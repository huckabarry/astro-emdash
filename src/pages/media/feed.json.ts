import type { APIRoute } from "astro";
import { getFeedMetadata, getMediaFeedItems, jsonFeedResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site?.toString().replace(/\/$/, "") || url.origin;
	const items = await getMediaFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();
	return jsonFeedResponse({
		siteUrl,
		path: "/media/feed.json",
		title: `${siteTitle} / Media`,
		description: "Albums, songs, books, movies, and shows from the media timeline.",
		items,
	});
};
