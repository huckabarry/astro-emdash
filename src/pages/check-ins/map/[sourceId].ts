import type { APIRoute } from "astro";

export const prerender = false;

const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 400;
const TILE_SIZE = 256;
const ZOOM = 15;
const MAX_LATITUDE = 85.05112878;
const TILE_URL_TEMPLATE = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";
const TILE_SUBDOMAINS = ["a", "b", "c", "d"];
const TILE_COPY = "\u00a9 OpenStreetMap contributors \u00a9 CARTO";
const TILE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const TILE_FETCH_TIMEOUT_MS = 1200;
const PREVIEW_RENDER_BUDGET_MS = 1800;

function escapeXml(value: string) {
	return String(value || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function toCoordinate(value: string | null) {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function normalizeLatitude(latitude: number) {
	return clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE);
}

function getWorldSize(zoom: number) {
	return TILE_SIZE * 2 ** zoom;
}

function projectX(longitude: number, zoom: number) {
	return ((longitude + 180) / 360) * getWorldSize(zoom);
}

function projectY(latitude: number, zoom: number) {
	const radians = (normalizeLatitude(latitude) * Math.PI) / 180;
	const mercator = Math.log(Math.tan(Math.PI / 4 + radians / 2));
	return (0.5 - mercator / (2 * Math.PI)) * getWorldSize(zoom);
}

function wrapTileX(tileX: number, zoom: number) {
	const tileCount = 2 ** zoom;
	return ((tileX % tileCount) + tileCount) % tileCount;
}

function clampTileY(tileY: number, zoom: number) {
	return clamp(tileY, 0, 2 ** zoom - 1);
}

function getTileUrl(zoom: number, tileX: number, tileY: number) {
	const wrappedX = wrapTileX(tileX, zoom);
	const clampedY = clampTileY(tileY, zoom);
	const subdomain = TILE_SUBDOMAINS[Math.abs(wrappedX + clampedY) % TILE_SUBDOMAINS.length] || "a";
	return TILE_URL_TEMPLATE
		.replace("{s}", subdomain)
		.replace("{z}", String(zoom))
		.replace("{x}", String(wrappedX))
		.replace("{y}", String(clampedY));
}

function toBase64(buffer: ArrayBuffer) {
	// Node compatibility flag is enabled; Buffer is much faster than btoa + string concatenation.
	// eslint-disable-next-line no-undef
	return Buffer.from(buffer).toString("base64");
}

async function fetchTileArrayBuffer(tileUrl: string, deadlineMs: number) {
	const cache = caches?.default;
	const cacheKey = new Request(tileUrl, { method: "GET" });

	if (cache) {
		const cached = await cache.match(cacheKey);
		if (cached) {
			return await cached.arrayBuffer();
		}
	}

	const timeoutMs = Math.max(120, Math.min(TILE_FETCH_TIMEOUT_MS, deadlineMs));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(tileUrl, {
			signal: controller.signal,
			headers: {
				accept: "image/png,image/*;q=0.8,*/*;q=0.5",
				"user-agent": "Afterword check-in preview (+https://afterword.blog)",
			},
			cf: {
				cacheEverything: true,
				cacheTtl: TILE_CACHE_TTL_SECONDS,
			},
		} as RequestInit);

		if (!response.ok) {
			throw new Error(`tile fetch failed with ${response.status}`);
		}

		const clone = response.clone();
		const buffer = await response.arrayBuffer();

		if (cache) {
			// Best-effort: avoid blocking preview rendering on cache writes.
			void cache.put(cacheKey, clone).catch(() => {});
		}

		return buffer;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchTileDataUrl(zoom: number, tileX: number, tileY: number, deadlineAt: number) {
	const tileUrl = getTileUrl(zoom, tileX, tileY);
	const deadlineMs = Math.max(0, deadlineAt - Date.now());
	const buffer = await fetchTileArrayBuffer(tileUrl, deadlineMs);
	return `data:image/png;base64,${toBase64(buffer)}`;
}

function renderFallbackSvg(sourceId: string, latitude: number, longitude: number) {
	const latitudeLabel = latitude.toFixed(4);
	const longitudeLabel = longitude.toFixed(4);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" role="img" aria-label="Map preview">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f2f3ef" />
      <stop offset="100%" stop-color="#e5e7e1" />
    </linearGradient>
  </defs>
  <rect width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" fill="url(#bg)" />
  <g stroke="#cfd4cc" stroke-width="1">
    <path d="M0 80 H${PREVIEW_WIDTH}" />
    <path d="M0 160 H${PREVIEW_WIDTH}" />
    <path d="M0 240 H${PREVIEW_WIDTH}" />
    <path d="M0 320 H${PREVIEW_WIDTH}" />
    <path d="M128 0 V${PREVIEW_HEIGHT}" />
    <path d="M256 0 V${PREVIEW_HEIGHT}" />
    <path d="M384 0 V${PREVIEW_HEIGHT}" />
    <path d="M512 0 V${PREVIEW_HEIGHT}" />
  </g>
  <g transform="translate(${PREVIEW_WIDTH / 2}, ${PREVIEW_HEIGHT / 2})">
    <circle r="15" fill="#f4f3ac" stroke="#202123" stroke-width="3" />
    <circle r="4.5" fill="#202123" opacity="0.32" />
  </g>
  <rect x="18" y="${PREVIEW_HEIGHT - 52}" width="180" height="34" rx="8" fill="rgba(255,255,255,0.78)" />
  <text x="30" y="${PREVIEW_HEIGHT - 30}" font-family="IBM Plex Mono, monospace" font-size="14" fill="#4c554c">${escapeXml(latitudeLabel)}, ${escapeXml(longitudeLabel)}</text>
  <text x="${PREVIEW_WIDTH - 16}" y="${PREVIEW_HEIGHT - 16}" font-family="IBM Plex Mono, monospace" font-size="10.5" fill="#7b8378" text-anchor="end">${escapeXml(sourceId)}</text>
</svg>`;
}

async function renderPreviewSvg(sourceId: string, latitude: number, longitude: number) {
	const startedAt = Date.now();
	const deadlineAt = startedAt + PREVIEW_RENDER_BUDGET_MS;
	const centerX = projectX(longitude, ZOOM);
	const centerY = projectY(latitude, ZOOM);
	const startX = centerX - PREVIEW_WIDTH / 2;
	const startY = centerY - PREVIEW_HEIGHT / 2;
	const startTileX = Math.floor(startX / TILE_SIZE);
	const startTileY = Math.floor(startY / TILE_SIZE);
	const endTileX = Math.floor((startX + PREVIEW_WIDTH - 1) / TILE_SIZE);
	const endTileY = Math.floor((startY + PREVIEW_HEIGHT - 1) / TILE_SIZE);

	const tileRequests: Array<Promise<string>> = [];
	const placements: Array<{ x: number; y: number }> = [];

	for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
		for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
			tileRequests.push(fetchTileDataUrl(ZOOM, tileX, tileY, deadlineAt));
			placements.push({
				x: tileX * TILE_SIZE - startX,
				y: tileY * TILE_SIZE - startY,
			});
		}
	}

	try {
		if (Date.now() > deadlineAt) {
			throw new Error("preview render budget exceeded");
		}

		const tileDataUrls = await Promise.all(tileRequests);
		const tileImages = tileDataUrls
			.map((href, index) => {
				const placement = placements[index];
				// Overlap tiles slightly to avoid 1px seams from fractional positioning.
				const x = Math.round(placement.x);
				const y = Math.round(placement.y);
				return `<image href="${href}" x="${x}" y="${y}" width="${TILE_SIZE + 1}" height="${TILE_SIZE + 1}" preserveAspectRatio="none" />`;
			})
			.join("");

		return `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" role="img" aria-label="Map preview">
  <defs>
    <clipPath id="frame">
      <rect width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" rx="24" ry="24" />
    </clipPath>
  </defs>
  <g clip-path="url(#frame)">${tileImages}</g>
  <rect width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" rx="24" ry="24" fill="none" stroke="rgba(32,33,35,0.14)" />
  <g transform="translate(${(PREVIEW_WIDTH / 2).toFixed(2)}, ${(PREVIEW_HEIGHT / 2).toFixed(2)})">
    <circle r="15" fill="#f4f3ac" stroke="#202123" stroke-width="3" />
    <circle r="4.5" fill="#202123" opacity="0.32" />
  </g>
  <rect x="16" y="${PREVIEW_HEIGHT - 32}" width="212" height="18" rx="9" fill="rgba(255,255,255,0.88)" />
  <text x="28" y="${PREVIEW_HEIGHT - 19}" font-family="IBM Plex Mono, monospace" font-size="10.5" fill="#425049">${escapeXml(TILE_COPY)}</text>
</svg>`;
	} catch (error) {
		void error;
		return renderFallbackSvg(sourceId, latitude, longitude);
	}
}

export const GET: APIRoute = async ({ params, url }) => {
	const latitude = toCoordinate(url.searchParams.get("lat"));
	const longitude = toCoordinate(url.searchParams.get("lng"));
	const sourceId = String(params.sourceId || "").trim() || "checkin";

	if (latitude === null || longitude === null) {
		return new Response("Missing coordinates", { status: 400 });
	}

	const svg = await renderPreviewSvg(sourceId, latitude, longitude);

	return new Response(svg, {
		headers: {
			"content-type": "image/svg+xml; charset=utf-8",
			"cache-control": "public, max-age=31536000, immutable",
		},
	});
};
