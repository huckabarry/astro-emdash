import type { APIRoute } from "astro";
import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { Kysely, sql } from "kysely";
import { runMigrations } from "emdash/db";
import { applySeed, validateSeed } from "emdash/seed";

export const prerender = false;

const IMPORT_TOKEN = "afterword-import-2026-04-05";

export const POST: APIRoute = async ({ request }) => {
	try {
		const headerToken = request.headers.get("x-afterword-import-token");
		const urlToken = new URL(request.url).searchParams.get("token");
		if (headerToken !== IMPORT_TOKEN && urlToken !== IMPORT_TOKEN) {
			return new Response("Not found", { status: 404 });
		}

		const payload = await request.json();
		const scope = payload?.scope === "posts" ? "posts" : "bootstrap";
		const offset = Number.isFinite(payload?.offset) ? Number(payload.offset) : 0;
		const limit = Number.isFinite(payload?.limit) ? Number(payload.limit) : 0;
		const totalPosts = Number.isFinite(payload?.totalPosts) ? Number(payload.totalPosts) : 0;
		const scopedSeed = payload?.seed;

		const validation = validateSeed(scopedSeed);
		if (!validation.valid) {
			return Response.json(
				{ ok: false, error: "Invalid seed file.", details: validation.errors },
				{ status: 400 },
			);
		}

		const db = new Kysely<any>({
			dialect: createDialect({ binding: "DB", session: "auto" }),
		});

		if (scope !== "posts") {
			await runMigrations(db);
		}

		const result = await applySeed(db, scopedSeed, {
			includeContent: true,
			onConflict: "update",
			skipMediaDownload: true,
		});

		const postEntries = Array.isArray(scopedSeed.content?.posts) ? scopedSeed.content.posts : [];
		let timestampUpdates = 0;

		for (const entry of postEntries) {
			const publishedAt =
				typeof entry?.data?.source_published_at === "string"
					? entry.data.source_published_at.trim()
					: "";

			if (!publishedAt) continue;

			await sql`
				UPDATE ec_posts
				SET published_at = ${publishedAt},
					created_at = ${publishedAt}
				WHERE slug = ${entry.slug}
			`.execute(db);

			timestampUpdates += 1;
		}

		return Response.json({
			ok: true,
			scope,
			result,
			timestampUpdates,
			offset,
			limit,
			totalPosts,
			nextOffset:
				scope === "posts" && offset + postEntries.length < totalPosts
					? offset + postEntries.length
					: null,
			postCount: postEntries.length,
		});
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : null,
			},
			{ status: 500 },
		);
	}
};
