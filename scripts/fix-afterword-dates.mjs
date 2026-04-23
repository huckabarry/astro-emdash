import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const seed = (await import("../seed/seed.json", { with: { type: "json" } })).default;

const CHUNK_SIZE = Number.parseInt(process.env.CHUNK_SIZE || "200", 10) || 200;

function sqlString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

async function main() {
	const posts = (Array.isArray(seed.content?.posts) ? seed.content.posts : [])
		.map((post) => ({
			slug: post.slug,
			publishedAt:
				typeof post?.data?.source_published_at === "string"
					? post.data.source_published_at.trim()
					: "",
		}))
		.filter((post) => post.slug && post.publishedAt);

	const tempDir = await mkdtemp(path.join(os.tmpdir(), "afterword-date-fix-"));

	try {
		for (let i = 0; i < posts.length; i += CHUNK_SIZE) {
			const chunk = posts.slice(i, i + CHUNK_SIZE);
			const caseClause = chunk
				.map((post) => `WHEN ${sqlString(post.slug)} THEN ${sqlString(post.publishedAt)}`)
				.join("\n");
			const slugList = chunk.map((post) => sqlString(post.slug)).join(", ");

			const sql = `
UPDATE ec_posts
SET
  published_at = CASE slug
${caseClause}
    ELSE published_at
  END,
  created_at = CASE slug
${caseClause}
    ELSE created_at
  END
WHERE slug IN (${slugList});
`;

			const sqlPath = path.join(tempDir, `dates-${i}.sql`);
			await writeFile(sqlPath, sql, "utf8");

			console.log(`Updating dates for posts ${i} to ${i + chunk.length - 1}...`);
			const { stdout, stderr } = await execFileAsync(
				"fnm",
				[
					"exec",
					"--using",
					"22.22.0",
					"npx",
					"wrangler",
					"d1",
					"execute",
					"afterword-emdash-lab",
					"--remote",
					"--file",
					sqlPath,
				],
				{ cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
			);

			if (stdout.trim()) console.log(stdout.trim());
			if (stderr.trim()) console.error(stderr.trim());
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}

	console.log("Date repair complete.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
