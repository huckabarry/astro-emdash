import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
	const target = new URL("https://sync.afterword.blog/admin/checkins/callback");
	target.search = url.search;
	return Response.redirect(target.toString(), 308);
};
