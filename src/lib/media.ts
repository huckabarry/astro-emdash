const MEDIA_TIMELINE_URL = "https://afterword.blog/media/timeline.json";
const MEDIA_CACHE_TTL_MS = 1000 * 60 * 5;

export type MediaTimelineLink = {
	label: string;
	url: string;
	external: boolean;
};

export type MediaTimelineItem = {
	id: string;
	kind: "track" | "album" | "popfeed";
	label: string;
	title: string;
	href: string;
	dateIso: string;
	dateLabel: string;
	summary: string;
	imageUrl: string | null;
	imageAlt: string | null;
	tags: string[];
	artist?: string;
	audioUrl?: string | null;
	credit?: string;
	links: MediaTimelineLink[];
	mediaType?: string;
	statusLabel?: string;
	activityLabel?: string;
};

function getMediaCache() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroMediaCache?: Map<number, { expiresAt: number; items: MediaTimelineItem[] }>;
		__afterwordAstroMediaPromises?: Map<number, Promise<MediaTimelineItem[]>>;
	};

	if (!scope.__afterwordAstroMediaCache) {
		scope.__afterwordAstroMediaCache = new Map();
	}

	if (!scope.__afterwordAstroMediaPromises) {
		scope.__afterwordAstroMediaPromises = new Map();
	}

	return scope;
}

function toAbsoluteUrl(value: string | null | undefined) {
	const normalized = String(value || "").trim();
	if (!normalized) {
		return null;
	}

	try {
		return new URL(normalized, "https://afterword.blog").toString();
	} catch {
		return normalized;
	}
}

async function fetchMedia(limit: number) {
	const response = await fetch(`${MEDIA_TIMELINE_URL}?offset=0&limit=${limit}`, {
		headers: { accept: "application/json" },
	});

	if (!response.ok) {
		throw new Error(`Unable to fetch media timeline: ${response.status}`);
	}

	const payload = (await response.json()) as {
		items?: Array<Record<string, unknown>>;
	};

	return (payload.items || []).map((item) => ({
		id: String(item.id || ""),
		kind: String(item.kind || "popfeed") as MediaTimelineItem["kind"],
		label: String(item.label || ""),
		title: String(item.title || ""),
		href: toAbsoluteUrl(String(item.href || "")) || "/media",
		dateIso: String(item.dateIso || ""),
		dateLabel: String(item.dateLabel || ""),
		summary: String(item.summary || ""),
		imageUrl: toAbsoluteUrl(String(item.imageUrl || "")),
		imageAlt: String(item.imageAlt || ""),
		tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag)) : [],
		artist: typeof item.artist === "string" ? item.artist : undefined,
		audioUrl: toAbsoluteUrl(String(item.audioUrl || "")),
		credit: typeof item.credit === "string" ? item.credit : undefined,
		links: Array.isArray(item.links)
			? item.links.map((link) => ({
					label: String((link as { label?: string }).label || ""),
					url: toAbsoluteUrl(String((link as { url?: string }).url || "")) || "/media",
					external: Boolean((link as { external?: boolean }).external),
				}))
			: [],
		mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
		statusLabel: typeof item.statusLabel === "string" ? item.statusLabel : undefined,
		activityLabel: typeof item.activityLabel === "string" ? item.activityLabel : undefined,
	}));
}

export async function getMediaTimeline(limit = 24) {
	const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 60));
	const scope = getMediaCache();
	const cached = scope.__afterwordAstroMediaCache?.get(normalizedLimit);

	if (cached && cached.expiresAt > Date.now()) {
		return cached.items;
	}

	const inflight = scope.__afterwordAstroMediaPromises?.get(normalizedLimit);
	if (inflight) {
		return inflight;
	}

	const request = fetchMedia(normalizedLimit)
		.then((items) => {
			scope.__afterwordAstroMediaCache?.set(normalizedLimit, {
				expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
				items,
			});
			return items;
		})
		.finally(() => {
			scope.__afterwordAstroMediaPromises?.delete(normalizedLimit);
		});

	scope.__afterwordAstroMediaPromises?.set(normalizedLimit, request);
	return request;
}
