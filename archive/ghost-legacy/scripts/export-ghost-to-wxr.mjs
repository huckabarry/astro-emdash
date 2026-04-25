import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = "/Users/bryanrobb/Git/afterword-sveltekit-pds/data/ghost-posts-lite.json";
const DEFAULT_OUTPUT = path.resolve(process.cwd(), "imports", "ghost-sample-20.xml");
const DEFAULT_SITE_URL = "https://afterword.blog";
const DEFAULT_SITE_TITLE = "Afterword";
const DEFAULT_AUTHOR = {
	login: "bryan",
	email: "bryan@example.com",
	displayName: "Bryan",
	firstName: "Bryan",
	lastName: "",
};

function getArg(name, fallback) {
	const prefix = `--${name}=`;
	const value = process.argv.find((arg) => arg.startsWith(prefix));
	return value ? value.slice(prefix.length) : fallback;
}

function xmlEscape(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function cdata(value) {
	return `<![CDATA[${String(value ?? "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function slugify(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 180);
}

function toWpDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function collectTags(posts) {
	const map = new Map();
	for (const post of posts) {
		for (const rawTag of post.tags || []) {
			const name = typeof rawTag === "string" ? rawTag : rawTag?.name;
			if (!name) continue;
			const slug = slugify(typeof rawTag === "string" ? rawTag : rawTag.slug || rawTag.name);
			if (!slug || map.has(slug)) continue;
			map.set(slug, { slug, name });
		}
	}
	return [...map.values()];
}

function parsePosts(data) {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.posts)) return data.posts;
	return [];
}

function postTagXml(post) {
	return (post.tags || [])
		.map((rawTag) => {
			const name = typeof rawTag === "string" ? rawTag : rawTag?.name;
			const slug = slugify(typeof rawTag === "string" ? rawTag : rawTag?.slug || rawTag?.name);
			if (!name || !slug) return "";
			return `    <category domain="post_tag" nicename="${xmlEscape(slug)}">${cdata(name)}</category>`;
		})
		.filter(Boolean)
		.join("\n");
}

function buildAttachmentItem(post, attachmentId) {
	if (!post.feature_image) return "";
	const title = `${post.title || "Post"} Cover Image`;
	const date = toWpDate(post.published_at || post.created_at || new Date().toISOString());
	const modified = toWpDate(post.updated_at || post.published_at || new Date().toISOString());
	return `
  <item>
    <title>${cdata(title)}</title>
    <link>${xmlEscape(post.feature_image)}</link>
    <pubDate>${xmlEscape(new Date(post.published_at || Date.now()).toUTCString())}</pubDate>
    <dc:creator>${cdata(DEFAULT_AUTHOR.login)}</dc:creator>
    <guid isPermaLink="false">${xmlEscape(post.feature_image)}</guid>
    <description></description>
    <content:encoded>${cdata("")}</content:encoded>
    <excerpt:encoded>${cdata("")}</excerpt:encoded>
    <wp:post_id>${attachmentId}</wp:post_id>
    <wp:post_date>${xmlEscape(date)}</wp:post_date>
    <wp:post_date_gmt>${xmlEscape(date)}</wp:post_date_gmt>
    <wp:post_modified>${xmlEscape(modified)}</wp:post_modified>
    <wp:post_modified_gmt>${xmlEscape(modified)}</wp:post_modified_gmt>
    <wp:comment_status>closed</wp:comment_status>
    <wp:ping_status>closed</wp:ping_status>
    <wp:status>inherit</wp:status>
    <wp:post_name>${xmlEscape(slugify(`${post.slug || title}-cover`))}</wp:post_name>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type>attachment</wp:post_type>
    <wp:is_sticky>0</wp:is_sticky>
    <wp:attachment_url>${xmlEscape(post.feature_image)}</wp:attachment_url>
  </item>`.trim();
}

function buildPostItem(post, postId, attachmentId, siteUrl) {
	const publishedAt = post.published_at || post.created_at || new Date().toISOString();
	const updatedAt = post.updated_at || publishedAt;
	const pubDate = new Date(publishedAt).toUTCString();
	const wpDate = toWpDate(publishedAt);
	const wpModified = toWpDate(updatedAt);
	const excerpt = post.custom_excerpt || post.excerpt || "";
	const tagsXml = postTagXml(post);
	const metaXml = attachmentId
		? `
    <wp:postmeta>
      <wp:meta_key>${cdata("_thumbnail_id")}</wp:meta_key>
      <wp:meta_value>${cdata(String(attachmentId))}</wp:meta_value>
    </wp:postmeta>`
		: "";
	return `
  <item>
    <title>${cdata(post.title || "Untitled")}</title>
    <link>${xmlEscape(`${siteUrl}/posts/${post.slug}`)}</link>
    <pubDate>${xmlEscape(pubDate)}</pubDate>
    <dc:creator>${cdata(DEFAULT_AUTHOR.login)}</dc:creator>
    <guid isPermaLink="false">${xmlEscape(`${siteUrl}/posts/${post.slug}`)}</guid>
    <description>${cdata(excerpt)}</description>
    <content:encoded>${cdata(post.html || "")}</content:encoded>
    <excerpt:encoded>${cdata(excerpt)}</excerpt:encoded>
    <wp:post_id>${postId}</wp:post_id>
    <wp:post_date>${xmlEscape(wpDate)}</wp:post_date>
    <wp:post_date_gmt>${xmlEscape(wpDate)}</wp:post_date_gmt>
    <wp:post_modified>${xmlEscape(wpModified)}</wp:post_modified>
    <wp:post_modified_gmt>${xmlEscape(wpModified)}</wp:post_modified_gmt>
    <wp:comment_status>closed</wp:comment_status>
    <wp:ping_status>closed</wp:ping_status>
    <wp:status>publish</wp:status>
    <wp:post_name>${xmlEscape(post.slug || slugify(post.title || postId))}</wp:post_name>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type>post</wp:post_type>
    <wp:is_sticky>0</wp:is_sticky>
${tagsXml ? `${tagsXml}\n` : ""}${metaXml}
  </item>`.trim();
}

async function main() {
	const input = path.resolve(getArg("input", DEFAULT_INPUT));
	const output = path.resolve(getArg("output", DEFAULT_OUTPUT));
	const count = Number.parseInt(getArg("count", "20"), 10);
	const siteUrl = getArg("site-url", DEFAULT_SITE_URL);
	const siteTitle = getArg("site-title", DEFAULT_SITE_TITLE);

	const raw = await fs.readFile(input, "utf8");
	const data = JSON.parse(raw);
	const posts = parsePosts(data)
		.filter((post) => post?.title && post?.slug && post?.html)
		.sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime())
		.slice(0, count);

	if (!posts.length) {
		throw new Error(`No posts found in ${input}`);
	}

	const tags = collectTags(posts);
	const channelItems = [];
	let nextId = 1000;

	for (const post of posts) {
		const postId = nextId++;
		const attachmentId = post.feature_image ? nextId++ : undefined;
		channelItems.push(buildPostItem(post, postId, attachmentId, siteUrl));
		if (attachmentId) {
			channelItems.push(buildAttachmentItem(post, attachmentId));
		}
	}

	const tagXml = tags
		.map(
			(tag, index) => `
    <wp:tag>
      <wp:term_id>${index + 1}</wp:term_id>
      <wp:tag_slug>${cdata(tag.slug)}</wp:tag_slug>
      <wp:tag_name>${cdata(tag.name)}</wp:tag_name>
      <wp:tag_description>${cdata("")}</wp:tag_description>
    </wp:tag>`.trim(),
		)
		.join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>${cdata(siteTitle)}</title>
  <link>${xmlEscape(siteUrl)}</link>
  <description>${cdata("Ghost posts exported for EmDash import testing")}</description>
  <pubDate>${xmlEscape(new Date().toUTCString())}</pubDate>
  <language>en-US</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>${xmlEscape(siteUrl)}</wp:base_site_url>
  <wp:base_blog_url>${xmlEscape(siteUrl)}</wp:base_blog_url>
  <wp:author>
    <wp:author_id>1</wp:author_id>
    <wp:author_login>${cdata(DEFAULT_AUTHOR.login)}</wp:author_login>
    <wp:author_email>${cdata(DEFAULT_AUTHOR.email)}</wp:author_email>
    <wp:author_display_name>${cdata(DEFAULT_AUTHOR.displayName)}</wp:author_display_name>
    <wp:author_first_name>${cdata(DEFAULT_AUTHOR.firstName)}</wp:author_first_name>
    <wp:author_last_name>${cdata(DEFAULT_AUTHOR.lastName)}</wp:author_last_name>
  </wp:author>
${tagXml ? `${tagXml}\n` : ""}${channelItems.join("\n")}
</channel>
</rss>
`;

	await fs.mkdir(path.dirname(output), { recursive: true });
	await fs.writeFile(output, xml, "utf8");

	console.log(`Exported ${posts.length} Ghost posts to ${output}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
