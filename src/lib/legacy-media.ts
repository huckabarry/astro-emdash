const LEGACY_IMAGE_HOSTS = new Set([
	"afterword.blog",
	"www.afterword.blog",
	"lowvelocity.org",
	"www.lowvelocity.org",
]);

export function rewriteLegacyMediaUrl(rawUrl: string, origin = ""): string {
	if (!rawUrl) return rawUrl;

	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return rawUrl;
	}

	if (!LEGACY_IMAGE_HOSTS.has(parsed.hostname)) {
		return rawUrl;
	}

	const proxyUrl = new URL("/legacy-media", origin || parsed.origin);
	proxyUrl.searchParams.set("src", parsed.toString());
	return proxyUrl.toString();
}

export function isLegacyMediaUrl(rawUrl: string): boolean {
	try {
		return LEGACY_IMAGE_HOSTS.has(new URL(rawUrl).hostname);
	} catch {
		return false;
	}
}
