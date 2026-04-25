import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async () => {
	return Response.redirect("https://sync.afterword.blog/admin/posts", 303);
};
