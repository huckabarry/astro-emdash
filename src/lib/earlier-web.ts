import { extractPlainText, getEmDashCollection, getEmDashEntry } from "emdash";
import { portableTextToMarkdown } from "emdash/client";

const EARLIER_WEB_CACHE_TTL_MS = 1000 * 60 * 10;
export const EARLIER_WEB_STREAM_PAGE_SIZE = 30;

type EarlierWebEntry = {
	id: string;
	data: {
		id?: string | null;
		title?: string | null;
		excerpt?: string | null;
		publishedAt?: Date | string | null;
		featured_image?: unknown;
		content?: unknown;
		source_path?: string | null;
		source_type?: string | null;
		source_published_at?: string | null;
	};
};

export type EarlierWebYearSummary = {
	year: number;
	postCount: number;
	firstPublishedAt: string | null;
	lastPublishedAt: string | null;
};

export type EarlierWebPostSummary = {
	id: string;
	slug: string;
	year: number;
	month: number;
	title: string;
	excerpt: string;
	path: string;
	coverImage: string | null;
	hasImages: boolean;
	publishedAt: string;
	sourcePath: string;
	bodyTextLength: number;
	sourceType: string | null;
	sourceConfidence: string | null;
};

export type EarlierWebPost = EarlierWebPostSummary & {
	bodyMarkdown: string;
	bodyHtml: string;
	content: unknown[];
};

export type EarlierWebStreamHydratedPage = {
	posts: EarlierWebPost[];
	cursor: string | null;
	limit: number;
};

function getCacheScope() {
	const scope = globalThis as typeof globalThis & {
		__afterwordAstroEarlierWeb?: {
			expiresAt: number;
			entries: EarlierWebEntry[];
		} | null;
		__afterwordAstroEarlierWebPromise?: Promise<EarlierWebEntry[]> | null;
	};

	if (!("__afterwordAstroEarlierWeb" in scope)) {
		scope.__afterwordAstroEarlierWeb = null;
		scope.__afterwordAstroEarlierWebPromise = null;
	}

	return scope;
}

function getString(value: unknown) {
	return String(value || "").trim();
}

function getPublishedDate(entry: EarlierWebEntry) {
	const sourcePublishedAt = getString(entry.data.source_published_at);
	const sourceDate = sourcePublishedAt ? new Date(sourcePublishedAt) : null;
	if (sourceDate && !Number.isNaN(sourceDate.getTime())) {
		return sourceDate;
	}

	const publishedAt = entry.data.publishedAt;
	if (publishedAt instanceof Date && !Number.isNaN(publishedAt.getTime())) {
		return publishedAt;
	}

	const fallback = new Date(String(publishedAt || ""));
	return Number.isNaN(fallback.getTime()) ? new Date(0) : fallback;
}

function getMonthSegment(month: number) {
	return String(month).padStart(2, "0");
}

function getPortableTextBlocks(entry: EarlierWebEntry) {
	return Array.isArray(entry.data.content) ? (entry.data.content as unknown[]) : [];
}

function markdownFromEntry(entry: EarlierWebEntry) {
	try {
		return portableTextToMarkdown(getPortableTextBlocks(entry) as never).trim();
	} catch {
		return "";
	}
}

function getBodyTextLength(entry: EarlierWebEntry) {
	try {
		return extractPlainText(getPortableTextBlocks(entry) as never).trim().length;
	} catch {
		return getString(entry.data.excerpt).length;
	}
}

function hasImageMarkdown(markdown: string) {
	return /!\[[^\]]*\]\([^)]+\)/.test(markdown);
}

export function shouldSurfaceEarlierWebTitle(post: {
	title: string;
	excerpt: string;
	bodyTextLength: number;
}) {
	if (Number(post.bodyTextLength || 0) < 500) {
		return false;
	}

	const title = post.title.trim().toLowerCase();
	const excerpt = post.excerpt.trim().toLowerCase();

	if (!title || !excerpt) {
		return false;
	}

	return !(title === excerpt || excerpt.startsWith(title) || title.startsWith(excerpt));
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderInlineText(value: string) {
	return escapeHtml(value).replace(
		/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
		(_, label: string, href: string) =>
			`<a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer">${escapeHtml(label)}</a>`,
	);
}

function renderParagraph(text: string) {
	return `<p>${renderInlineText(text).replace(/\n/g, "<br>")}</p>`;
}

function renderImageLine(line: string) {
	const match = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);

	if (!match) {
		return null;
	}

	const [, alt, src] = match;
	return `<figure class="earlier-web-post__figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" /></figure>`;
}

function renderImageBlock(block: string) {
	const matches = [...block.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];

	if (!matches.length) {
		return null;
	}

	const leftover = block.replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim();

	if (leftover) {
		return null;
	}

	const figures = matches.map((match) => {
		const alt = match[1] || "";
		const src = match[2] || "";
		return `<figure class="earlier-web-post__figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" /></figure>`;
	});

	if (figures.length === 1) {
		return figures[0];
	}

	return `<div class="earlier-web-post__gallery">${figures.join("")}</div>`;
}

export function renderEarlierWebBody(bodyMarkdown: string) {
	const normalized = String(bodyMarkdown || "").replace(/\r\n/g, "\n").trim();

	if (!normalized) {
		return "";
	}

	const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
	const rendered: string[] = [];

	for (const block of blocks) {
		const imageBlockHtml = renderImageBlock(block);

		if (imageBlockHtml) {
			rendered.push(imageBlockHtml);
			continue;
		}

		const imageHtml = renderImageLine(block);

		if (imageHtml) {
			rendered.push(imageHtml);
			continue;
		}

		rendered.push(renderParagraph(block));
	}

	return rendered.join("\n");
}

function toSummary(entry: EarlierWebEntry): EarlierWebPostSummary {
	const publishedAt = getPublishedDate(entry);
	const year = publishedAt.getUTCFullYear();
	const month = publishedAt.getUTCMonth() + 1;
	const bodyMarkdown = markdownFromEntry(entry);
	const coverImage =
		typeof entry.data.featured_image === "object" && entry.data.featured_image
			? String((entry.data.featured_image as { src?: string }).src || "").trim() || null
			: null;

	return {
		id: entry.data.id ? String(entry.data.id) : entry.id,
		slug: entry.id,
		year,
		month,
		title: getString(entry.data.title),
		excerpt: getString(entry.data.excerpt),
		path: `/earlier-web/${year}/${getMonthSegment(month)}/${entry.id}`,
		coverImage,
		hasImages: hasImageMarkdown(bodyMarkdown),
		publishedAt: publishedAt.toISOString(),
		sourcePath: getString(entry.data.source_path),
		bodyTextLength: getBodyTextLength(entry),
		sourceType: getString(entry.data.source_type) || null,
		sourceConfidence: null,
	};
}

function toPost(entry: EarlierWebEntry): EarlierWebPost {
	const summary = toSummary(entry);
	const bodyMarkdown = markdownFromEntry(entry);
	return {
		...summary,
		bodyMarkdown,
		bodyHtml: renderEarlierWebBody(bodyMarkdown),
		content: getPortableTextBlocks(entry),
	};
}

async function fetchAllEarlierWebEntries() {
	const scope = getCacheScope();
	const cached = scope.__afterwordAstroEarlierWeb;

	if (cached && cached.expiresAt > Date.now()) {
		return cached.entries;
	}

	if (scope.__afterwordAstroEarlierWebPromise) {
		return scope.__afterwordAstroEarlierWebPromise;
	}

	const request = getEmDashCollection("posts", {
		status: "published",
		where: { tag: "earlier-web" },
		orderBy: { published_at: "desc" },
	})
		.then(({ entries }) => {
			scope.__afterwordAstroEarlierWeb = {
				expiresAt: Date.now() + EARLIER_WEB_CACHE_TTL_MS,
				entries: entries as EarlierWebEntry[],
			};
			return entries as EarlierWebEntry[];
		})
		.finally(() => {
			scope.__afterwordAstroEarlierWebPromise = null;
		});

	scope.__afterwordAstroEarlierWebPromise = request;
	return request;
}

export async function getEarlierWebYears() {
	const entries = await fetchAllEarlierWebEntries();
	const years = new Map<number, EarlierWebYearSummary>();

	for (const entry of entries) {
		const publishedAt = getPublishedDate(entry).toISOString();
		const year = new Date(publishedAt).getUTCFullYear();
		const existing = years.get(year);

		if (!existing) {
			years.set(year, {
				year,
				postCount: 1,
				firstPublishedAt: publishedAt,
				lastPublishedAt: publishedAt,
			});
			continue;
		}

		existing.postCount += 1;
		existing.firstPublishedAt =
			existing.firstPublishedAt && existing.firstPublishedAt < publishedAt
				? existing.firstPublishedAt
				: publishedAt;
		existing.lastPublishedAt =
			existing.lastPublishedAt && existing.lastPublishedAt > publishedAt
				? existing.lastPublishedAt
				: publishedAt;
	}

	return [...years.values()].sort((left, right) => right.year - left.year);
}

export async function getEarlierWebYearPosts(year: number) {
	const entries = await fetchAllEarlierWebEntries();
	return entries
		.filter((entry) => getPublishedDate(entry).getUTCFullYear() === year)
		.map(toSummary)
		.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
}

export async function getEarlierWebOnThisDayPosts(date: Date, limit = 3) {
	const entries = await fetchAllEarlierWebEntries();
	const month = date.getMonth();
	const day = date.getDate();

	return entries
		.filter((entry) => {
			const publishedAt = getPublishedDate(entry);
			return publishedAt.getUTCMonth() === month && publishedAt.getUTCDate() === day;
		})
		.sort((left, right) => Date.parse(right.data.source_published_at as string) - Date.parse(left.data.source_published_at as string))
		.slice(0, limit)
		.map(toSummary);
}

export async function getEarlierWebStreamHydratedPage({
	cursor,
	limit = EARLIER_WEB_STREAM_PAGE_SIZE,
}: {
	cursor?: string | null;
	limit?: number;
} = {}): Promise<EarlierWebStreamHydratedPage> {
	const { entries, nextCursor } = await getEmDashCollection("posts", {
		status: "published",
		where: { tag: "earlier-web" },
		orderBy: { published_at: "desc" },
		cursor: cursor || undefined,
		limit,
	});

	return {
		posts: (entries as EarlierWebEntry[]).map(toPost),
		cursor: nextCursor || null,
		limit,
	};
}

export async function getEarlierWebPostByDateSlug(year: number, month: number, slug: string) {
	const { entry } = await getEmDashEntry("posts", slug);

	if (!entry) {
		return null;
	}

	const earlierWebEntry = entry as EarlierWebEntry;
	const sourceType = getString(earlierWebEntry.data.source_type);
	if (!sourceType || sourceType === "ghost") {
		return null;
	}

	const publishedAt = getPublishedDate(earlierWebEntry);
	if (publishedAt.getUTCFullYear() !== year || publishedAt.getUTCMonth() + 1 !== month) {
		return null;
	}

	return toPost(earlierWebEntry);
}
