function withOrigin(url: string, origin: string): string {
	if (!url) return url;
	if (url.startsWith("http://") || url.startsWith("https://")) return url;
	if (url.startsWith("/")) return origin ? `${origin}${url}` : url;
	return url;
}

export function getImageUrl(image: unknown, origin = ""): string | null {
	if (!image || typeof image !== "object") return null;
	const value = image as Record<string, unknown>;

	if (typeof value.src === "string" && value.src) {
		return withOrigin(value.src, origin);
	}

	const asset =
		typeof value.asset === "object" && value.asset ? (value.asset as Record<string, unknown>) : undefined;
	if (typeof asset?.url === "string" && asset.url) {
		return withOrigin(asset.url, origin);
	}

	const assetRef = typeof asset?._ref === "string" ? asset._ref : undefined;
	if (assetRef) {
		return withOrigin(`/_emdash/api/media/file/${assetRef}`, origin);
	}

	const meta = value.meta as Record<string, unknown> | undefined;
	const storageKey =
		(typeof meta?.storageKey === "string" ? meta.storageKey : undefined) ||
		(typeof value.id === "string" ? value.id : undefined);

	if (storageKey) {
		return withOrigin(`/_emdash/api/media/file/${storageKey}`, origin);
	}

	return null;
}

export function getImageAlt(image: unknown, fallback: string): string {
	if (!image || typeof image !== "object") return fallback;
	const value = image as Record<string, unknown>;
	return typeof value.alt === "string" && value.alt.trim() ? value.alt : fallback;
}

export function formatDisplayDate(date: Date | null | undefined) {
	if (!date) return "";

	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function collectPortableTextImages(value: unknown, images: unknown[]) {
	if (!Array.isArray(value)) return;

	for (const block of value) {
		if (!block || typeof block !== "object") continue;
		const typedBlock = block as Record<string, unknown>;

		if (typedBlock._type === "image") {
			images.push(block);
			continue;
		}

		if (typedBlock._type === "gallery" && Array.isArray(typedBlock.images)) {
			collectPortableTextImages(typedBlock.images, images);
		}

		if (typedBlock._type === "columns" && Array.isArray(typedBlock.columns)) {
			for (const column of typedBlock.columns) {
				if (!column || typeof column !== "object") continue;
				const content = (column as Record<string, unknown>).content;
				if (Array.isArray(content)) {
					collectPortableTextImages(content, images);
				}
			}
		}
	}
}

export function getPortableTextImages(value: unknown): unknown[] {
	const images: unknown[] = [];
	collectPortableTextImages(value, images);
	return images;
}
