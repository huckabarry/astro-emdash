import type { APIRoute } from "astro";
import { getEverythingFeedItems, getFeedMetadata, xmlFeedResponse } from "../../lib/feeds";

export const prerender = false;

export const GET: APIRoute = async ({ site, url }) => {
	const items = await getEverythingFeedItems(site, url);
	const { siteTitle } = getFeedMetadata();

	return xmlFeedResponse({
		siteUrl: site?.toString().replace(/\/$/, "") || url.origin,
		path: "/everything/feed.xml",
		title: `${siteTitle} / Everything`,
		description: "The full public stream from Afterword: writing, status, media, check-ins, and archive posts.",
		items,
	});
};
