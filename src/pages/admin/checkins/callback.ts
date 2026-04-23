import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { Kysely } from "kysely";

export const prerender = false;

const FOURSQUARE_AUTH_BASE = "https://foursquare.com/oauth2";
const FOURSQUARE_API_BASE = "https://api.foursquare.com/v2";
const FOURSQUARE_API_VERSION = "20260330";

const STATE_COOKIE = "afterword_swarm_oauth_state";
const SIG_COOKIE = "afterword_swarm_oauth_sig";

type RuntimeEnv = Record<string, unknown>;

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function getAdminToken(runtimeEnv: RuntimeEnv) {
	return normalizeString(runtimeEnv.SWARM_SYNC_TOKEN || runtimeEnv.FOURSQUARE_SYNC_TOKEN || runtimeEnv.FOURSQUARE_PUSH_SECRET);
}

function getFoursquareClientId(runtimeEnv: RuntimeEnv) {
	return normalizeString(runtimeEnv.FOURSQUARE_CLIENT_ID || runtimeEnv.SWARM_CLIENT_ID);
}

function getFoursquareClientSecret(runtimeEnv: RuntimeEnv) {
	return normalizeString(runtimeEnv.FOURSQUARE_CLIENT_SECRET || runtimeEnv.SWARM_CLIENT_SECRET);
}

function getCallbackUrl(origin: string) {
	return `${origin}/admin/checkins/callback`;
}

function toHex(bytes: Uint8Array) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signState(state: string, secret: string) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(state));
	return toHex(new Uint8Array(sig));
}

function safeEqual(a: string, b: string) {
	const left = normalizeString(a);
	const right = normalizeString(b);
	if (!left || !right || left.length !== right.length) return false;
	let mismatch = 0;
	for (let i = 0; i < left.length; i += 1) {
		mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return mismatch === 0;
}

function getDb() {
	return new Kysely<any>({
		dialect: createDialect({ binding: "DB", session: "auto" }),
	});
}

async function ensureTables(db: Kysely<any>) {
	await db.schema
		.createTable("afterword_swarm_oauth")
		.ifNotExists()
		.addColumn("id", "integer", (col) => col.primaryKey().notNull())
		.addColumn("access_token", "text")
		.addColumn("user_id", "text")
		.addColumn("user_name", "text")
		.addColumn("photo_url", "text")
		.addColumn("connected_at", "text")
		.addColumn("updated_at", "text")
		.execute();
}

async function exchangeCodeForAccessToken({
	clientId,
	clientSecret,
	code,
	redirectUri,
}: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
}) {
	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
		code,
	});

	const response = await fetch(`${FOURSQUARE_AUTH_BASE}/access_token?${params.toString()}`, {
		headers: { accept: "application/json" },
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Swarm token exchange failed (${response.status}): ${body}`);
	}

	const payload = (await response.json()) as { access_token?: string };
	const accessToken = normalizeString(payload.access_token);
	if (!accessToken) {
		throw new Error("Swarm token exchange did not return an access token.");
	}

	return accessToken;
}

async function fetchFoursquareUser(accessToken: string) {
	const url = new URL(`${FOURSQUARE_API_BASE}/users/self`);
	url.searchParams.set("v", FOURSQUARE_API_VERSION);

	const response = await fetch(url.toString(), {
		headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
	});

	if (!response.ok) {
		return { userId: null, name: null, photoUrl: null };
	}

	const payload = (await response.json()) as {
		response?: {
			user?: {
				id?: string | number;
				firstName?: string;
				lastName?: string;
				photo?: { prefix?: string; suffix?: string } | string;
			};
		};
	};

	const user = payload.response?.user || {};
	const userId = normalizeString(user.id) || null;
	const name = [normalizeString(user.firstName), normalizeString(user.lastName)].filter(Boolean).join(" ") || null;

	let photoUrl = "";
	if (typeof user.photo === "string") {
		photoUrl = user.photo;
	} else if (user.photo?.prefix && user.photo?.suffix) {
		photoUrl = `${user.photo.prefix}original${user.photo.suffix}`;
	}

	return {
		userId,
		name,
		photoUrl: normalizeString(photoUrl) || null,
	};
}

export const GET: APIRoute = async ({ url, cookies }) => {
	const runtimeEnv: RuntimeEnv = env as unknown as RuntimeEnv;
	const adminToken = getAdminToken(runtimeEnv);
	const clientId = getFoursquareClientId(runtimeEnv);
	const clientSecret = getFoursquareClientSecret(runtimeEnv);

	if (!adminToken || !clientId || !clientSecret) {
		return new Response("Swarm/Foursquare is not configured.", { status: 503 });
	}

	const errorDescription =
		normalizeString(url.searchParams.get("error_description")) ||
		normalizeString(url.searchParams.get("error"));
	if (errorDescription) {
		return new Response(`Swarm authorization failed: ${errorDescription}`, { status: 400 });
	}

	const code = normalizeString(url.searchParams.get("code"));
	const submittedState = normalizeString(url.searchParams.get("state"));
	const expectedState = normalizeString(cookies.get(STATE_COOKIE)?.value);
	const expectedSig = normalizeString(cookies.get(SIG_COOKIE)?.value);

	// Clear cookies regardless of outcome.
	cookies.delete(STATE_COOKIE, { path: "/" });
	cookies.delete(SIG_COOKIE, { path: "/" });

	if (!code) {
		return new Response("Missing Swarm authorization code.", { status: 400 });
	}

	if (!submittedState || !expectedState || submittedState !== expectedState) {
		return new Response("Invalid Swarm authorization state.", { status: 400 });
	}

	const computedSig = await signState(submittedState, adminToken);
	if (!expectedSig || !safeEqual(expectedSig, computedSig)) {
		return new Response("Swarm authorization signature mismatch.", { status: 400 });
	}

	const redirectUri = getCallbackUrl(url.origin);
	const accessToken = await exchangeCodeForAccessToken({
		clientId,
		clientSecret,
		code,
		redirectUri,
	});

	const user = await fetchFoursquareUser(accessToken);
	const db = getDb();
	await ensureTables(db);

	const now = new Date().toISOString();
	await db
		.insertInto("afterword_swarm_oauth")
		.values({
			id: 1,
			access_token: accessToken,
			user_id: user.userId,
			user_name: user.name,
			photo_url: user.photoUrl,
			connected_at: now,
			updated_at: now,
		})
		.onConflict((oc) =>
			oc.column("id").doUpdateSet({
				access_token: accessToken,
				user_id: user.userId,
				user_name: user.name,
				photo_url: user.photoUrl,
				updated_at: now,
			}),
		)
		.execute();

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Swarm Connected</title>
    <meta http-equiv="refresh" content="2;url=/_emdash/admin" />
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 32px; }
      code { background: rgba(0,0,0,.06); padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>Swarm Connected</h1>
    <p>Authorization saved. You can close this tab.</p>
    <p>Push URL: <code>${escapeHtml(url.origin)}/api/swarm/push</code></p>
  </body>
</html>`;

	return new Response(html, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
};

function escapeHtml(value: string) {
	return String(value || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

