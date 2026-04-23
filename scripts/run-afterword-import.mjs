const ORIGIN = "https://afterword-emdash-lab.bryan-robb.workers.dev";
const TOKEN = "afterword-import-2026-04-05";
const DEFAULT_BATCH_SIZE = 40;
const MIN_BATCH_SIZE = 1;

const seed = (await import("../seed/seed.json", { with: { type: "json" } })).default;

function buildBootstrapSeed() {
	return {
		...seed,
		content: {
			pages: Array.isArray(seed.content?.pages) ? seed.content.pages : [],
		},
	};
}

function buildPostBatchSeed(offset, limit) {
	const posts = Array.isArray(seed.content?.posts) ? seed.content.posts : [];
	return {
		version: seed.version,
		bylines: Array.isArray(seed.bylines) ? seed.bylines : [],
		content: {
			posts: posts.slice(offset, offset + limit),
		},
	};
}

async function callImport({ scope, offset = 0, limit = 0, totalPosts = 0, seed: scopedSeed }) {
	const url = new URL("/api/import-afterword", ORIGIN);
	url.searchParams.set("token", TOKEN);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"x-afterword-import-token": TOKEN,
		},
		body: JSON.stringify({
			scope,
			offset,
			limit,
			totalPosts,
			seed: scopedSeed,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		const error = new Error(`Import request failed (${response.status}): ${text.slice(0, 500)}`);
		error.status = response.status;
		error.body = text;
		throw error;
	}

	return response.json();
}

async function main() {
	const totalPosts = Array.isArray(seed.content?.posts) ? seed.content.posts.length : 0;
	const skipBootstrap = process.env.SKIP_BOOTSTRAP === "1";
	const initialBatchSize = Number.parseInt(process.env.BATCH_SIZE || `${DEFAULT_BATCH_SIZE}`, 10) || DEFAULT_BATCH_SIZE;

	if (!skipBootstrap) {
		console.log("Bootstrapping schema, settings, menus, and pages...");
		const bootstrap = await callImport({
			scope: "bootstrap",
			totalPosts,
			seed: buildBootstrapSeed(),
		});
		console.log(
			`Bootstrap complete: pages=${bootstrap.result.content.updated + bootstrap.result.content.created}`,
		);
	}

	let offset = Number.parseInt(process.env.START_OFFSET || "0", 10) || 0;
	const endOffset = Number.parseInt(process.env.END_OFFSET || `${totalPosts}`, 10) || totalPosts;
	let batch = 1;
	let batchSize = initialBatchSize;
	let successStreak = 0;

	while (offset < endOffset) {
		const effectiveBatchSize = Math.min(batchSize, endOffset - offset);
		console.log(
			`Importing posts batch ${batch} starting at offset ${offset} with batch size ${effectiveBatchSize}...`,
		);

		let result;
		try {
			result = await callImport({
				scope: "posts",
				offset,
				limit: effectiveBatchSize,
				totalPosts,
				seed: buildPostBatchSeed(offset, effectiveBatchSize),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isResourceError =
				message.includes("1102") ||
				message.includes("worker_exceeded_resources") ||
				message.includes("resource limits");

			if (isResourceError && batchSize > MIN_BATCH_SIZE) {
				batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
				successStreak = 0;
				console.log(`Batch hit Worker limits. Retrying offset ${offset} with batch size ${batchSize}.`);
				continue;
			}

			throw error;
		}

		console.log(
			`Batch ${batch} complete: processed=${result.postCount}, created=${result.result.content.created}, updated=${result.result.content.updated}, nextOffset=${result.nextOffset ?? "done"}`,
		);
		successStreak += 1;
		if (successStreak >= 5 && batchSize < initialBatchSize) {
			batchSize = Math.min(initialBatchSize, batchSize * 2);
			successStreak = 0;
			console.log(`Stepping batch size back up to ${batchSize}.`);
		}

		if (result.nextOffset == null || result.nextOffset >= endOffset) break;

		offset = result.nextOffset;
		batch += 1;
	}

	console.log("Earlier Web import complete.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
