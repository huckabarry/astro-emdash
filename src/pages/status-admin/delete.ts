import type { APIRoute } from "astro";

import { deleteStatusRecord, getStatusRecordKey } from "../../lib/status";

export const prerender = false;

function redirectWithMessage(origin: URL, ok: boolean, message: string) {
	const url = new URL("/status-admin", origin);
	url.searchParams.set("ok", ok ? "1" : "0");
	url.searchParams.set("message", message);
	return Response.redirect(url.toString(), 303);
}

export const POST: APIRoute = async ({ request, locals, session }) => {
	const user = locals.user || (await session?.get("user"));
	if (!user) {
		return Response.redirect(new URL("/_emdash/admin/login?redirect=/status-admin", request.url), 303);
	}

	const runtimeLocals = locals as unknown as { runtime?: { env?: Record<string, unknown> } };
	const env = runtimeLocals.runtime?.env ?? (import.meta.env as Record<string, unknown>);
	const formData = await request.formData();
	const uri = String(formData.get("uri") || "").trim();

	if (!uri) {
		return redirectWithMessage(new URL(request.url), false, "Missing Bluesky post URI.");
	}

	try {
		const rkey = getStatusRecordKey(uri);
		await deleteStatusRecord(env, rkey);
		return redirectWithMessage(new URL(request.url), true, "Bluesky post deleted.");
	} catch (error) {
		return redirectWithMessage(
			new URL(request.url),
			false,
			error instanceof Error ? error.message : "Unable to delete Bluesky post.",
		);
	}
};
