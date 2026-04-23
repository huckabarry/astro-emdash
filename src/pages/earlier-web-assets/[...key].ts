import type { APIRoute } from "astro";

import { serveLegacyAsset } from "../../lib/legacy-assets";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
	return serveLegacyAsset(params.key, {
		notFoundLabel: "Asset",
		prefixes: ["earlier-web-assets"],
	});
};
