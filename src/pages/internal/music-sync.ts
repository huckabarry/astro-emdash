import type { APIRoute } from "astro";

export const prerender = false;

function deprecatedResponse() {
	return new Response(
		"This endpoint is deprecated on the Astro/EmDash worker. Remove the Echofeed trigger for /internal/music-sync.\n",
		{
			status: 410,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			},
		},
	);
}

export const GET: APIRoute = async () => deprecatedResponse();
export const POST: APIRoute = async () => deprecatedResponse();

