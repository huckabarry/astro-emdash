import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async () => {
	return Response.redirect("https://sync.afterword.blog/admin/checkins/connect", 308);
};
