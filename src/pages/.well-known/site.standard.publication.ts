import type { APIRoute } from "astro";

export const prerender = false;

const FALLBACK_PUBLICATION_URI = "at://did:plc:vt4k6d3e5rjw65cuzaf3nufq/site.standard.publication/3mk5ifnbo552g";

export const GET: APIRoute = async ({ request, locals }) => {
	let publicationUri = String(process.env.STANDARD_SITE_PUBLICATION_URI || FALLBACK_PUBLICATION_URI).trim();

	try {
		const result = await locals.emdash?.handlePluginApiRoute(
			"atproto",
			"GET",
			"/verification",
			new Request(request.url, { method: "GET" }),
		);

		const pluginPublicationUri = String(
			(result?.data as { publicationUri?: string | null } | undefined)?.publicationUri || "",
		).trim();
		if (result?.success && pluginPublicationUri) {
			publicationUri = pluginPublicationUri;
		}
	} catch (error) {
		console.error("Failed to load AT Protocol publication verification", error);
	}

	if (!publicationUri) {
		return new Response("Not found", {
			status: 404,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
			},
		});
	}

	return new Response(`${publicationUri}\n`, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
		},
	});
};
