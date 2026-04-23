import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { imageSize } from "image-size";
import { ulid } from "ulidx";

const execFile = promisify(execFileCallback);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DIR = path.join(ROOT, ".tmp", "lowvelocity-localize");
const DB_NAME = "afterword-emdash-lab";
const R2_BUCKET = "afterword-emdash-lab";
const TAGS = ["photography", "gallery", "field-notes"];
const LOWVELOCITY_HOSTS = new Set(["lowvelocity.org", "www.lowvelocity.org"]);
const APPLY = process.argv.includes("--apply");
const WRANGLER_RETRIES = 3;

function sqlQuote(value) {
	return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function toStorageKey(url) {
	const parsed = new URL(url);
	const filename = path.basename(parsed.pathname) || "image";
	const ext = path.extname(filename);
	const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9._-]+/g, "-") || "image";
	const normalizedExt = ext.replace(/[^a-zA-Z0-9.]+/g, "").toLowerCase() || "";
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
	return `lowvelocity-${hash}-${base}${normalizedExt}`;
}

function buildLocalMediaValue(item, alt = "") {
	return {
		provider: "local",
		id: item.id,
		src: `/_emdash/api/media/file/${item.storageKey}`,
		alt: alt || item.alt || "",
		width: item.width ?? undefined,
		height: item.height ?? undefined,
		filename: item.filename,
		mimeType: item.mimeType,
		meta: {
			storageKey: item.storageKey,
		},
	};
}

function buildPortableTextAsset(item) {
	return {
		_ref: item.id,
		url: `/_emdash/api/media/file/${item.storageKey}`,
		provider: "local",
		meta: {
			storageKey: item.storageKey,
		},
	};
}

function looksLikeLowvelocityUrl(value) {
	try {
		return LOWVELOCITY_HOSTS.has(new URL(String(value)).hostname);
	} catch {
		return false;
	}
}

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

async function runWrangler(args, { input } = {}) {
	const options = {
		cwd: ROOT,
		maxBuffer: 1024 * 1024 * 50,
	};

	if (input !== undefined) {
		options.input = input;
	}

	let lastError;
	for (let attempt = 1; attempt <= WRANGLER_RETRIES; attempt += 1) {
		try {
			const { stdout, stderr } = await execFile("npm", ["exec", "--", "wrangler", ...args], options);
			return { stdout, stderr };
		} catch (error) {
			lastError = error;
			const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
			const transientCloudflareError =
				output.includes('"code": 7403') ||
				output.includes("not authorized to access this service") ||
				output.includes("fetch failed") ||
				output.includes("ECONNRESET") ||
				output.includes("ETIMEDOUT");
			if (!transientCloudflareError || attempt === WRANGLER_RETRIES) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
		}
	}

	throw lastError;
}

async function d1Json(sql) {
	const { stdout } = await runWrangler([
		"d1",
		"execute",
		DB_NAME,
		"--remote",
		"--json",
		"--command",
		sql,
	]);
	return JSON.parse(stdout);
}

async function d1ExecFile(sql) {
	await ensureDir(TMP_DIR);
	const filePath = path.join(TMP_DIR, `query-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
	await fs.writeFile(filePath, sql, "utf8");
	try {
		await runWrangler(["d1", "execute", DB_NAME, "--remote", "--file", filePath]);
	} finally {
		await fs.rm(filePath, { force: true });
	}
}

async function r2Put(storageKey, filePath, mimeType) {
	await runWrangler([
		"r2",
		"object",
		"put",
		`${R2_BUCKET}/${storageKey}`,
		"--remote",
		"--force",
		"--file",
		filePath,
		"--content-type",
		mimeType,
		"--cache-control",
		"public, max-age=31536000, immutable",
	]);
}

async function fetchRows(sql) {
	const data = await d1Json(sql);
	return data[0]?.results || [];
}

async function fetchOne(sql) {
	const rows = await fetchRows(sql);
	return rows[0] || null;
}

async function getCandidatePosts() {
	const tagList = TAGS.map(sqlQuote).join(", ");
	return fetchRows(`
		SELECT DISTINCT p.id, p.slug, p.title, p.featured_image, p.content
		FROM ec_posts p
		JOIN content_taxonomies ct ON ct.entry_id = p.id AND ct.collection = 'posts'
		JOIN taxonomies t ON t.id = ct.taxonomy_id
		WHERE t.name = 'tag'
			AND t.slug IN (${tagList})
			AND (p.featured_image LIKE '%lowvelocity.org%' OR p.content LIKE '%lowvelocity.org%')
		ORDER BY p.published_at DESC, p.created_at DESC
	`);
}

async function findMediaByStorageKey(storageKey) {
	return fetchOne(`
		SELECT id, filename, mime_type AS mimeType, size, width, height, alt, storage_key AS storageKey
		FROM media
		WHERE storage_key = ${sqlQuote(storageKey)}
		LIMIT 1
	`);
}

async function findMediaByContentHash(contentHash) {
	return fetchOne(`
		SELECT id, filename, mime_type AS mimeType, size, width, height, alt, storage_key AS storageKey
		FROM media
		WHERE content_hash = ${sqlQuote(contentHash)}
		LIMIT 1
	`);
}

async function insertMediaRow(item) {
	await d1ExecFile(`
		INSERT INTO media (
			id, filename, mime_type, size, width, height, alt, caption, storage_key, content_hash,
			created_at, author_id, status, blurhash, dominant_color
		) VALUES (
			${sqlQuote(item.id)},
			${sqlQuote(item.filename)},
			${sqlQuote(item.mimeType)},
			${item.size == null ? "NULL" : Number(item.size)},
			${item.width == null ? "NULL" : Number(item.width)},
			${item.height == null ? "NULL" : Number(item.height)},
			${item.alt ? sqlQuote(item.alt) : "NULL"},
			NULL,
			${sqlQuote(item.storageKey)},
			${sqlQuote(item.contentHash)},
			${sqlQuote(new Date().toISOString())},
			NULL,
			'ready',
			NULL,
			NULL
		);
	`);
}

function getFilenameFromUrl(url) {
	const pathname = new URL(url).pathname;
	return path.basename(pathname) || "image";
}

function parseJson(value, fallback) {
	if (!value) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const mediaCache = new Map();

async function localizeUrlToMedia(url, alt = "") {
	if (mediaCache.has(url)) {
		return mediaCache.get(url);
	}

	const task = (async () => {
		const storageKey = toStorageKey(url);
		const existingByKey = await findMediaByStorageKey(storageKey);
		if (existingByKey) {
			return existingByKey;
		}

		if (!APPLY) {
			return {
				id: `dryrun-${storageKey}`,
				filename: getFilenameFromUrl(url),
				mimeType: "image/jpeg",
				size: null,
				width: null,
				height: null,
				alt: alt || null,
				storageKey,
			};
		}

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch ${url}: ${response.status}`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const filename = getFilenameFromUrl(url);
		const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
		const size = buffer.byteLength;
		const contentHash = createHash("sha256").update(buffer).digest("hex");
		const existingByHash = await findMediaByContentHash(contentHash);
		if (existingByHash) {
			return existingByHash;
		}

		let width = null;
		let height = null;
		try {
			const dimensions = imageSize(buffer);
			width = typeof dimensions.width === "number" ? dimensions.width : null;
			height = typeof dimensions.height === "number" ? dimensions.height : null;
		} catch {
			// Leave dimensions null if image-size can't infer them.
		}

		await ensureDir(TMP_DIR);
		const tempPath = path.join(TMP_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`);
		await fs.writeFile(tempPath, buffer);

		try {
			await r2Put(storageKey, tempPath, mimeType);
		} finally {
			await fs.rm(tempPath, { force: true });
		}

		const mediaItem = {
			id: ulid(),
			filename,
			mimeType,
			size,
			width,
			height,
			alt: alt || null,
			storageKey,
			contentHash,
		};

		await insertMediaRow(mediaItem);
		return mediaItem;
	})();

	mediaCache.set(url, task);
	return task;
}

async function rewriteFeaturedImage(featuredImage) {
	if (!isObject(featuredImage)) {
		return { value: featuredImage, changed: false, migrated: 0 };
	}

	const sourceUrl = typeof featuredImage.src === "string" ? featuredImage.src : null;
	if (!sourceUrl || !looksLikeLowvelocityUrl(sourceUrl)) {
		return { value: featuredImage, changed: false, migrated: 0 };
	}

	const mediaItem = await localizeUrlToMedia(sourceUrl, typeof featuredImage.alt === "string" ? featuredImage.alt : "");
	return {
		value: buildLocalMediaValue(mediaItem, typeof featuredImage.alt === "string" ? featuredImage.alt : ""),
		changed: true,
		migrated: 1,
	};
}

async function rewritePortableTextNode(node) {
	if (Array.isArray(node)) {
		let changed = false;
		let migrated = 0;
		const next = [];
		for (const item of node) {
			const result = await rewritePortableTextNode(item);
			next.push(result.value);
			changed = changed || result.changed;
			migrated += result.migrated;
		}
		return { value: next, changed, migrated };
	}

	if (!isObject(node)) {
		return { value: node, changed: false, migrated: 0 };
	}

	if (node._type === "image" && isObject(node.asset) && looksLikeLowvelocityUrl(node.asset.url)) {
		const alt = typeof node.alt === "string" ? node.alt : "";
		const mediaItem = await localizeUrlToMedia(node.asset.url, alt);
		return {
			value: {
				...node,
				alt,
				width: mediaItem.width ?? node.width ?? undefined,
				height: mediaItem.height ?? node.height ?? undefined,
				asset: buildPortableTextAsset(mediaItem),
			},
			changed: true,
			migrated: 1,
		};
	}

	let changed = false;
	let migrated = 0;
	const next = Array.isArray(node) ? [] : { ...node };
	for (const [key, value] of Object.entries(node)) {
		if (key === "asset" || key === "src") continue;
		if (Array.isArray(value) || isObject(value)) {
			const result = await rewritePortableTextNode(value);
			next[key] = result.value;
			changed = changed || result.changed;
			migrated += result.migrated;
		}
	}

	return { value: next, changed, migrated };
}

async function updatePost(postId, featuredImage, content) {
	await d1ExecFile(`
		UPDATE ec_posts
		SET featured_image = ${featuredImage ? sqlQuote(JSON.stringify(featuredImage)) : "NULL"},
			content = ${content ? sqlQuote(JSON.stringify(content)) : "NULL"},
			updated_at = ${sqlQuote(new Date().toISOString())}
		WHERE id = ${sqlQuote(postId)};
	`);
}

async function main() {
	await ensureDir(TMP_DIR);

	const posts = await getCandidatePosts();
	const backupPath = path.join(TMP_DIR, `backup-${Date.now()}.json`);
	await fs.writeFile(backupPath, JSON.stringify(posts, null, 2));

	let changedPosts = 0;
	let migratedImages = 0;

	for (const post of posts) {
		const featuredImage = parseJson(post.featured_image, null);
		const content = parseJson(post.content, null);

		const featuredResult = await rewriteFeaturedImage(featuredImage);
		const contentResult = await rewritePortableTextNode(content);

		if (!featuredResult.changed && !contentResult.changed) {
			continue;
		}

		changedPosts += 1;
		migratedImages += featuredResult.migrated + contentResult.migrated;

		if (APPLY) {
			await updatePost(post.id, featuredResult.value, contentResult.value);
			console.log(`updated ${post.slug}: ${featuredResult.migrated + contentResult.migrated} image(s)`);
		} else {
			console.log(`would update ${post.slug}: ${featuredResult.migrated + contentResult.migrated} image(s)`);
		}
	}

	console.log(
		JSON.stringify(
			{
				mode: APPLY ? "apply" : "dry-run",
				postsScanned: posts.length,
				changedPosts,
				migratedImages,
				backupPath,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
