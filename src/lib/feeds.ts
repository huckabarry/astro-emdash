import { env } from "cloudflare:workers";
import { getEmDashCollection } from "emdash";
import { getCheckins } from "./checkins";
import {
	PLANNING_TAG_SLUGS,
	dedupeEntriesById,
	getPostStringField,
	sortEntriesByPublishedAtDesc,
} from "./emdash-content";
import { getImageAlt, getImageUrl } from "./afterword";
import { getMediaTimeline } from "./media";
import { getStatusFeedPage } from "./status-feed";

export type FeedItem = {
	id: string;
	title: string;
	path: string;
	url: string;
	date: Date;
	description: string;
	contentHtml?: string;
	section: string;
};

const siteTitle = "Afterword";
const siteDescription = "A quieter personal home for notes, photos, media, and wandering.";

function getSiteUrl(site: URL | undefined, url: URL) {
	return site?.toString().replace(/\/$/, "") || url.origin;
}

function escapeHtml(str: string): string {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function escapeXml(str: string): string {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function stripHtml(value: string) {
	return String(value || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function renderFeedImage(image: unknown, siteUrl: string, fallbackAlt: string, seenImages: Set<string>) {
	const src = getImageUrl(image, siteUrl);
	if (!src || seenImages.has(src)) {
		return "";
	}

	seenImages.add(src);
	return `<p><img src="${escapeHtml(src)}" alt="${escapeHtml(getImageAlt(image, fallbackAlt))}" /></p>`;
}

function renderPortableTextSpans(children: unknown, markDefs: unknown) {
	if (!Array.isArray(children)) {
		return "";
	}

	const marks = Array.isArray(markDefs)
		? new Map(
				markDefs
					.map((mark) => recordFromUnknown(mark))
					.filter(Boolean)
					.map((mark) => [String(mark?._key || ""), mark] as const),
			)
		: new Map<string, Record<string, unknown>>();

	return children
		.map((child) => {
			const span = recordFromUnknown(child);
			if (!span) return "";

			let html = escapeHtml(String(span.text || ""));
			const spanMarks = Array.isArray(span.marks) ? span.marks.map((mark) => String(mark)) : [];

			for (const mark of spanMarks) {
				if (mark === "strong") {
					html = `<strong>${html}</strong>`;
					continue;
				}
				if (mark === "em") {
					html = `<em>${html}</em>`;
					continue;
				}
				if (mark === "code") {
					html = `<code>${html}</code>`;
					continue;
				}

				const definition = marks.get(mark);
				const href = typeof definition?.href === "string" ? definition.href : "";
				if (href) {
					html = `<a href="${escapeHtml(href)}">${html}</a>`;
				}
			}

			return html;
		})
		.join("");
}

function renderPortableTextFeedHtml(
	content: unknown,
	siteUrl: string,
	fallbackAlt: string,
	seenImages: Set<string>,
): string {
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];

	for (const blockValue of content) {
		const block = recordFromUnknown(blockValue);
		if (!block) continue;

		if (block._type === "image") {
			const imageHtml = renderFeedImage(block, siteUrl, fallbackAlt, seenImages);
			if (imageHtml) parts.push(imageHtml);
			continue;
		}

		if (block._type === "gallery" && Array.isArray(block.images)) {
			for (const image of block.images) {
				const imageHtml = renderFeedImage(image, siteUrl, fallbackAlt, seenImages);
				if (imageHtml) parts.push(imageHtml);
			}
			continue;
		}

		if (block._type === "columns" && Array.isArray(block.columns)) {
			for (const columnValue of block.columns) {
				const column = recordFromUnknown(columnValue);
				const nestedHtml = renderPortableTextFeedHtml(
					column?.content,
					siteUrl,
					fallbackAlt,
					seenImages,
				);
				if (nestedHtml) parts.push(nestedHtml);
			}
			continue;
		}

		if (block._type === "htmlBlock" && typeof block.html === "string") {
			parts.push(block.html);
			continue;
		}

		if (block._type === "block") {
			const inlineHtml = renderPortableTextSpans(block.children, block.markDefs).trim();
			if (!inlineHtml) continue;

			const style = String(block.style || "normal");
			const tag = ["h2", "h3", "h4", "blockquote"].includes(style) ? style : "p";
			parts.push(`<${tag}>${inlineHtml}</${tag}>`);
		}
	}

	return parts.join("\n");
}

function buildPostFeedHtml(post: { data: Record<string, unknown> }, siteUrl: string) {
	const seenImages = new Set<string>();
	const title = String(post.data.title || "Untitled");
	const parts: string[] = [];
	const featuredImage = renderFeedImage(post.data.featured_image, siteUrl, title, seenImages);
	if (featuredImage) {
		parts.push(featuredImage);
	}

	const html = getPostStringField(post, "html");
	if (html) {
		parts.push(html);
	}

	const portableHtml = renderPortableTextFeedHtml(post.data.content, siteUrl, title, seenImages);
	if (portableHtml) {
		parts.push(portableHtml);
	}

	return parts.join("\n");
}

function buildStatusFeedHtml(post: Awaited<ReturnType<typeof getStatusFeedPage>>["statuses"][number]) {
	const parts: string[] = [];

	if (post.html) {
		parts.push(post.html);
	}

	for (const image of post.images) {
		const src = image.fullsize || image.thumb;
		if (!src) continue;
		parts.push(
			`<p><a href="${escapeHtml(post.blueskyUrl)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(src)}" alt="${escapeHtml(image.alt || "Bluesky image")}" /></a></p>`,
		);
	}

	if (post.video?.thumbnail) {
		parts.push(
			`<p><a href="${escapeHtml(post.blueskyUrl)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(post.video.thumbnail)}" alt="${escapeHtml(post.video.alt || "Bluesky video thumbnail")}" /></a></p>`,
		);
	}

	if (post.external) {
		const title = post.external.title || post.external.domain || post.external.uri;
		const description = post.external.description ? `<br>${escapeHtml(post.external.description)}` : "";
		const thumbnail = post.external.thumb
			? `<br><img src="${escapeHtml(post.external.thumb)}" alt="${escapeHtml(title)}" />`
			: "";
		parts.push(
			`<p><a href="${escapeHtml(post.external.uri)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>${description}${thumbnail}</p>`,
		);
	}

	return parts.join("\n");
}

function getStatusDescription(post: Awaited<ReturnType<typeof getStatusFeedPage>>["statuses"][number]) {
	const text = stripHtml(post.text);
	if (text) return text;
	if (post.images.length) return "Photo post";
	if (post.video) return "Video post";
	if (post.external) return post.external.title || post.external.domain || "Link post";
	return "Status update";
}

export function jsonResponse(data: unknown) {
	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
		},
	});
}

export function jsonFeedResponse(options: {
	siteUrl: string;
	path: string;
	title: string;
	description: string;
	items: FeedItem[];
}) {
	const { siteUrl, path, title, description, items } = options;

	const feed = {
		version: "https://jsonfeed.org/version/1.1",
		title: String(title || siteTitle),
		home_page_url: siteUrl,
		feed_url: `${siteUrl}${path}`,
		description: String(description || ""),
		authors: [{ name: "Bryan Robb" }],
		items: items.map((item) => {
			const contentHtml = String(item.contentHtml || "").trim();
			const contentText = stripHtml(contentHtml) || String(item.description || "").trim();
			return {
				id: String(item.id),
				url: String(item.url),
				title: String(item.title || ""),
				content_html: contentHtml || `<p>${escapeHtml(contentText)}</p>`,
				content_text: contentText,
				date_published: item.date.toISOString(),
				tags: [String(item.section || "").trim()].filter(Boolean),
			};
		}),
	};

	return new Response(JSON.stringify(feed, null, 2), {
		headers: {
			// JSON Feed uses application/feed+json, but micro.blog also accepts application/json.
			"content-type": "application/feed+json; charset=utf-8",
			"cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
		},
	});
}

export function xmlFeedResponse(options: {
	siteUrl: string;
	path: string;
	title: string;
	description: string;
	items: FeedItem[];
}) {
	const { siteUrl, path, title, description, items } = options;

	const body = items
		.map((item) => {
			const descriptionText = escapeXml(item.description);
			const content = item.contentHtml
				? `\n      <content:encoded><![CDATA[${item.contentHtml}]]></content:encoded>`
				: "";

			return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="true">${escapeXml(item.url)}</guid>
      <pubDate>${item.date.toUTCString()}</pubDate>
      <description>${descriptionText}</description>${content}
    </item>`;
		})
		.join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(description)}</description>
    <link>${escapeXml(siteUrl)}</link>
    <atom:link href="${escapeXml(`${siteUrl}${path}`)}" rel="self" type="application/rss+xml"/>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>`;

	return new Response(xml, {
		headers: {
			"content-type": "application/rss+xml; charset=utf-8",
			"cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
		},
	});
}

async function getAllPosts(limit = 80) {
	const { entries } = await getEmDashCollection("posts", {
		status: "published",
		orderBy: { published_at: "desc" },
		limit,
	});

	return entries;
}

export async function getWritingFeedItems(site: URL | undefined, url: URL) {
	const siteUrl = getSiteUrl(site, url);
	const posts = await getAllPosts(60);

	return posts
		.filter((post) => getPostStringField(post, "source_type") !== "earlier-web")
		.filter((post) => post.data.publishedAt)
		.map((post) => ({
			id: String(post.id),
			title: String(post.data.title || "Untitled"),
			path: `/posts/${post.id}`,
			url: `${siteUrl}/posts/${post.id}`,
			date: post.data.publishedAt as Date,
			description: stripHtml(String(post.data.excerpt || "")),
			contentHtml: buildPostFeedHtml(post, siteUrl),
			section: "Writing",
		} satisfies FeedItem));
}

export async function getPlanningFeedItems(site: URL | undefined, url: URL) {
	const siteUrl = getSiteUrl(site, url);
	const planningResults = await Promise.all(
		PLANNING_TAG_SLUGS.map((tag) =>
			getEmDashCollection("posts", {
				status: "published",
				where: { tag },
				orderBy: { published_at: "desc" },
				limit: 24,
			}),
		),
	);
	const posts = sortEntriesByPublishedAtDesc(
		dedupeEntriesById(planningResults.flatMap((result) => result.entries)),
	);

	return posts
		.filter(
			(post) =>
				getPostStringField(post, "source_type") !== "earlier-web" &&
				post.data.publishedAt,
		)
		.map((post) => ({
			id: String(post.id),
			title: String(post.data.title || "Untitled"),
			path: `/posts/${post.id}`,
			url: `${siteUrl}/posts/${post.id}`,
			date: post.data.publishedAt as Date,
			description: stripHtml(String(post.data.excerpt || "")),
			contentHtml: buildPostFeedHtml(post, siteUrl),
			section: "Planning",
		} satisfies FeedItem));
}

export async function getStatusFeedItems(site: URL | undefined, url: URL) {
	const siteUrl = getSiteUrl(site, url);
	const page = await getStatusFeedPage({ limit: 30, includeReplies: false });

	return page.statuses.map((post) => ({
		id: post.slug,
		title: stripHtml(post.text).slice(0, 80) || "Status update",
		path: `/status/${post.slug}`,
		url: `${siteUrl}/status/${post.slug}`,
		date: post.date,
		description: getStatusDescription(post),
		contentHtml: buildStatusFeedHtml(post),
		section: "Status",
	} satisfies FeedItem));
}

export async function getMediaFeedItems(site: URL | undefined, url: URL) {
	const siteUrl = getSiteUrl(site, url);
	const items = await getMediaTimeline(30);

	return items.map((item) => ({
		id: item.id,
		title: item.title,
		path: `/media#${item.id}`,
		url: `${siteUrl}/media#${item.id}`,
		date: new Date(item.dateIso),
		description: item.summary || item.label,
		section: "Media",
	} satisfies FeedItem));
}

export async function getCheckinFeedItems(site: URL | undefined, url: URL) {
	const siteUrl = getSiteUrl(site, url);
	const items = await getCheckins(env);

	return items.slice(0, 30).map((item) => ({
		id: item.slug,
		title: item.name,
		path: item.canonicalPath || `/check-ins/${item.slug}`,
		url: item.canonicalPath ? `${siteUrl}${item.canonicalPath}` : `${siteUrl}/check-ins/${item.slug}`,
		date: item.visitedAt,
		description: item.excerpt || item.note || item.place || "Check-in",
		section: "Check-ins",
	} satisfies FeedItem));
}

export async function getEverythingFeedItems(site: URL | undefined, url: URL) {
	const [writing, status, media, checkins] = await Promise.all([
		getWritingFeedItems(site, url),
		getStatusFeedItems(site, url),
		getMediaFeedItems(site, url),
		getCheckinFeedItems(site, url),
	]);

	return [...writing, ...status, ...media, ...checkins]
		.sort((a, b) => b.date.getTime() - a.date.getTime())
		.slice(0, 80);
}

export function getFeedMetadata() {
	return {
		siteTitle,
		siteDescription,
	};
}
