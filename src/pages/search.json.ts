import { getEmDashCollection } from "emdash";
import { extractText } from "../utils/reading-time";
import { PUBLIC_SEARCH_CACHE_CONTROL, getPostStringField } from "../lib/emdash-content";

export async function GET({ url }: { url: URL }) {
	const query = url.searchParams.get("q")?.trim().toLowerCase() || "";

	const { entries: posts } = await getEmDashCollection("posts", {
		status: "published",
		orderBy: { published_at: "desc" },
		limit: 120,
	});

	const index = posts
		.map((post) => ({
			id: post.data.id,
			path: `/posts/${post.id}`,
			title: post.data.title ?? "Untitled",
			excerpt: post.data.excerpt ?? "",
			section: getPostStringField(post, "source_type") === "earlier-web" ? "Earlier Web" : "Blog",
			publishedAt: post.data.publishedAt?.toISOString() ?? "",
			content: extractText(post.data.content).toLowerCase(),
		}));

	const results =
		query.length < 2
			? index.map(({ content: _content, ...post }) => post)
			: index
					.filter((post) => {
						const title = post.title.toLowerCase();
						const excerpt = post.excerpt.toLowerCase();
						return title.includes(query) || excerpt.includes(query) || post.content.includes(query);
					})
					.map(({ content: _content, ...post }) => post)
					.slice(0, 8);

	return new Response(JSON.stringify({ results }), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": PUBLIC_SEARCH_CACHE_CONTROL,
		},
	});
}
