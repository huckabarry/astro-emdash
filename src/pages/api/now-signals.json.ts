import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getLatestCheckin } from "../../lib/checkins";
import { getEarlierWebOnThisDayPosts } from "../../lib/earlier-web";
import { getLatestTrack } from "../../lib/media";
import { withTimeout } from "../../lib/network";

export const prerender = false;

export const GET: APIRoute = async () => {
	const [latestCheckin, latestTrack, onThisDayPosts] = await Promise.all([
		withTimeout(getLatestCheckin(env), 1200, null),
		withTimeout(getLatestTrack(), 1200, null),
		withTimeout(getEarlierWebOnThisDayPosts(new Date(), 3), 800, []),
	]);

	return new Response(
		JSON.stringify({
			latestCheckin,
			latestTrack,
			onThisDayPost: onThisDayPosts[0] || null,
		}),
		{
			headers: {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
			},
		},
	);
};
