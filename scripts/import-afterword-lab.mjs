import fs from "node:fs/promises";
import path from "node:path";

import TurndownService from "turndown";
import { markdownToPortableText } from "emdash/client";

const PROJECT_ROOT = "/Users/bryanrobb/Git/astro-emdash";
const AFTERWORD_ROOT = "/Users/bryanrobb/Git/afterword-sveltekit-pds";
const GHOST_INPUT = path.join(AFTERWORD_ROOT, "data", "ghost-posts-lite.json");
const ABOUT_INPUT = path.join(AFTERWORD_ROOT, "src", "content", "about.md");
const COLOPHON_INPUT = path.join(AFTERWORD_ROOT, "src", "content", "colophon.md");
const OUTPUT_SEED = path.join(PROJECT_ROOT, "seed", "seed.json");

const SITE_TITLE = "Afterword";
const SITE_TAGLINE = "An Astro and EmDash sandbox for trying things out.";
const PRIMARY_BYLINE_ID = "byline-bryan";

const EXCLUDED_TAGS = new Set(["status", "afterword", "now", "listening", "books"]);
const INTERNAL_TAG_PREFIX = "#";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
	emDelimiter: "_",
	strongDelimiter: "**",
});

turndown.addRule("figure", {
	filter: "figure",
	replacement(_content, node) {
		const imgs = Array.from(node.querySelectorAll?.("img") || []);
		const imgMarkdown = imgs
			.map((img) => {
				const src = img.getAttribute("src") || "";
				const alt = img.getAttribute("alt") || "";
				return src ? `![${alt}](${src})` : "";
			})
			.filter(Boolean)
			.join("\n\n");
		const caption = node.querySelector?.("figcaption")?.textContent?.trim();
		return `\n\n${imgMarkdown}${caption ? `\n\n_${caption}_` : ""}\n\n`;
	},
});

turndown.addRule("iframe", {
	filter: "iframe",
	replacement(_content, node) {
		const src = node.getAttribute("src") || "";
		return src ? `\n\n[Embedded media](${src})\n\n` : "\n\n";
	},
});

function slugify(value) {
	return String(value || "")
		.toLowerCase()
		.trim()
		.replace(/&/g, " and ")
		.replace(/['\".,!?()[\]{}:;]+/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function parseFrontmatter(markdown) {
	const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return { body: markdown.trim() };
	return { body: markdown.slice(match[0].length).trim() };
}

function toPortableTextFromMarkdown(markdown) {
	return markdownToPortableText(markdown);
}

function toPortableTextFromHtml(html) {
	const markdown = turndown
		.turndown(String(html || ""))
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return markdownToPortableText(markdown);
}

function formatTagLabel(slug) {
	return String(slug || "")
		.split("-")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function toPublicTags(post) {
	const rawTags = Array.isArray(post.tags) ? post.tags : [];
	return rawTags
		.map((tag) => {
			const name = typeof tag === "string" ? tag : tag?.name;
			const slug = slugify(typeof tag === "string" ? tag : tag?.slug || tag?.name);
			if (!name || !slug) return null;
			if (slug.startsWith("hash-")) return null;
			if (name.startsWith(INTERNAL_TAG_PREFIX)) return null;
			if (EXCLUDED_TAGS.has(slug)) return null;
			return { slug, label: typeof tag === "string" ? name : tag.name };
		})
		.filter(Boolean);
}

function buildHelloMarkdown() {
	return `If you're curious about this site or how to get in touch, here's a short guide.

## What this is

Afterword is my personal home on the web. It collects writing, photos, status notes, check-ins, and a few other traces of daily life.

## What I write about

- cities and neighborhoods
- architecture and transit
- photographs from walks and trips
- music, books, and the occasional stray observation

## Getting in touch

I don't mind people reaching out cold if there's a genuine reason.

- email is usually best when something is specific
- a note about cities, design, or personal publishing is always welcome
- if you want more context first, the [About](/pages/about) and [Colophon](/pages/colophon) pages explain the rest
`;
}

function toMediaReference(url, alt = "", filename) {
	if (!url) return null;
	return {
		$media: {
			url,
			alt: alt || undefined,
			filename: filename || undefined,
		},
	};
}

function filenameFromUrl(url) {
	try {
		return path.basename(new URL(url).pathname) || undefined;
	} catch {
		return undefined;
	}
}

function buildSeed({ aboutContent, helloContent, colophonContent, ghostPosts, tagMap }) {
	return {
		$schema: "https://emdashcms.com/seed.schema.json",
		version: "1",
		meta: {
			name: "Afterword Lab",
			description: "Afterword content for the Astro and EmDash sandbox",
			author: "Bryan Robb",
		},
		settings: {
			title: SITE_TITLE,
			tagline: SITE_TAGLINE,
		},
		collections: [
			{
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
				supports: ["drafts", "revisions", "search", "seo"],
				commentsEnabled: true,
				fields: [
					{
						slug: "title",
						label: "Title",
						type: "string",
						required: true,
						searchable: true,
					},
					{
						slug: "featured_image",
						label: "Featured Image",
						type: "image",
					},
					{
						slug: "content",
						label: "Content",
						type: "portableText",
						searchable: true,
					},
					{
						slug: "excerpt",
						label: "Excerpt",
						type: "text",
					},
				],
			},
			{
				slug: "pages",
				label: "Pages",
				labelSingular: "Page",
				supports: ["drafts", "revisions", "search"],
				fields: [
					{
						slug: "title",
						label: "Title",
						type: "string",
						required: true,
						searchable: true,
					},
					{
						slug: "content",
						label: "Content",
						type: "portableText",
						searchable: true,
					},
				],
			},
		],
		taxonomies: [
			{
				name: "tag",
				label: "Tags",
				labelSingular: "Tag",
				hierarchical: false,
				collections: ["posts"],
				terms: Array.from(tagMap.entries()).map(([slug, label]) => ({
					slug,
					label: label || formatTagLabel(slug),
				})),
			},
		],
		bylines: [
			{
				id: PRIMARY_BYLINE_ID,
				slug: "bryan",
				displayName: "Bryan",
				websiteUrl: "https://afterword.blog",
			},
		],
		menus: [
			{
				name: "primary",
				label: "Primary Navigation",
				items: [
					{ type: "custom", label: "Home", url: "/" },
					{ type: "custom", label: "About", url: "/pages/about" },
					{ type: "custom", label: "Hello", url: "/pages/hello" },
					{ type: "custom", label: "Colophon", url: "/pages/colophon" },
					{ type: "custom", label: "Posts", url: "/posts" },
				],
			},
		],
		widgetAreas: [
			{
				name: "footer",
				label: "Footer",
				description: "Footer copy for the Afterword sandbox",
				widgets: [
					{
						type: "content",
						title: "About",
						content: [
							{
								_type: "block",
								style: "normal",
								children: [
									{
										_type: "span",
										text: "An Astro and EmDash version of Afterword for trying on a different editorial feel.",
									},
								],
							},
						],
					},
				],
			},
		],
		content: {
			pages: [
				{
					id: "about",
					slug: "about",
					status: "published",
					data: {
						title: "About",
						content: aboutContent,
					},
				},
				{
					id: "hello",
					slug: "hello",
					status: "published",
					data: {
						title: "Hello",
						content: helloContent,
					},
				},
				{
					id: "colophon",
					slug: "colophon",
					status: "published",
					data: {
						title: "Colophon",
						content: colophonContent,
					},
				},
			],
			posts: ghostPosts.map((post) => ({
				id: `post-${post.slug}`,
				slug: post.slug,
				status: "published",
				data: {
					title: post.title,
					excerpt: post.custom_excerpt || post.excerpt || "",
					featured_image: post.feature_image
						? toMediaReference(
								post.feature_image,
								post.feature_image_alt || post.title,
								filenameFromUrl(post.feature_image),
							)
						: undefined,
					content: toPortableTextFromHtml(post.html),
				},
				bylines: [{ byline: PRIMARY_BYLINE_ID }],
				taxonomies: {
					tag: toPublicTags(post).map((tag) => tag.slug),
				},
			})),
		},
	};
}

async function main() {
	const rawGhost = JSON.parse(await fs.readFile(GHOST_INPUT, "utf8"));
	const ghostPosts = (Array.isArray(rawGhost) ? rawGhost : rawGhost.posts || [])
		.filter((post) => post?.title && post?.slug && post?.html && post?.status === "published")
		.sort((a, b) => new Date(a.published_at || 0).getTime() - new Date(b.published_at || 0).getTime());

	const aboutMarkdown = parseFrontmatter(await fs.readFile(ABOUT_INPUT, "utf8")).body;
	const colophonMarkdown = parseFrontmatter(await fs.readFile(COLOPHON_INPUT, "utf8")).body;
	const helloMarkdown = buildHelloMarkdown();

	const tagMap = new Map();
	for (const post of ghostPosts) {
		for (const tag of toPublicTags(post)) {
			tagMap.set(tag.slug, tag.label || formatTagLabel(tag.slug));
		}
	}

	const seed = buildSeed({
		aboutContent: toPortableTextFromMarkdown(aboutMarkdown),
		helloContent: toPortableTextFromMarkdown(helloMarkdown),
		colophonContent: toPortableTextFromMarkdown(colophonMarkdown),
		ghostPosts,
		tagMap,
	});

	await fs.mkdir(path.dirname(OUTPUT_SEED), { recursive: true });
	await fs.writeFile(OUTPUT_SEED, `${JSON.stringify(seed, null, "\t")}\n`, "utf8");

	console.log(`Wrote ${ghostPosts.length} posts and 3 pages to ${OUTPUT_SEED}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
