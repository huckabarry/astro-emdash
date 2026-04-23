export const PUBLIC_ARCHIVE_CACHE_CONTROL =
	"public, max-age=300, s-maxage=300, stale-while-revalidate=86400";

export const PUBLIC_SEARCH_CACHE_CONTROL =
	"public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

export const PLANNING_TAG_SLUGS = [
	"urbanism",
	"housing",
	"transportation",
	"public-finance",
] as const;

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}

	return value as Record<string, unknown>;
}

export function getPostTagSlugs(value: unknown): string[] {
	const record = recordFromUnknown(value);
	const data = recordFromUnknown(record?.data ?? record);
	const tags = data?.tags;

	if (!Array.isArray(tags)) {
		return [];
	}

	return tags
		.map((tag) => String(tag || "").trim())
		.filter(Boolean);
}

export function getPostStringField(value: unknown, key: string) {
	const record = recordFromUnknown(value);
	const data = recordFromUnknown(record?.data ?? record);
	const field = data?.[key];

	return typeof field === "string" && field.trim() ? field.trim() : null;
}

export function hasAnyPostTag(value: unknown, slugs: readonly string[]) {
	const tags = getPostTagSlugs(value);
	return slugs.some((slug) => tags.includes(slug));
}

export function fallbackTagLabel(slug: string) {
	return slug
		.split("-")
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(" ");
}

export function dedupeEntriesById<T extends { id: string }>(entries: T[]) {
	return Array.from(new Map(entries.map((entry) => [entry.id, entry])).values());
}

export function sortEntriesByPublishedAtDesc<T extends { data: { publishedAt?: Date | null } }>(
	entries: T[],
) {
	return [...entries].sort((left, right) => {
		const leftTime = left.data.publishedAt?.getTime() ?? 0;
		const rightTime = right.data.publishedAt?.getTime() ?? 0;
		return rightTime - leftTime;
	});
}
