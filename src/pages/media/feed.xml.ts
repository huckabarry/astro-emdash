import type { APIRoute } from "astro";
import { getFeedMetadata, getMediaFeedItems, xmlFeedResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getMediaFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();

	return xmlFeedResponse({
		siteUrl: site?.toString().replace(/\/$/, "") || url.origin,
		path: "/media/feed.xml",
		title: `${siteTitle} / Media`,
		description: "Albums, songs, books, movies, and shows from the media timeline.",
		items,
	});
};
