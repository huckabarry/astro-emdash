import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

const FOURSQUARE_AUTH_BASE = "https://foursquare.com/oauth2";
const STATE_COOKIE = "afterword_swarm_oauth_state";
const SIG_COOKIE = "afterword_swarm_oauth_sig";

type RuntimeEnv = Record<string, unknown>;

function normalizeString(value: unknown) {
	return String(value || "").trim();
}

function getAdminToken(runtimeEnv: RuntimeEnv) {
	// Prefer an explicit admin token, but fall back to the push secret so setup is minimal.
	return normalizeString(runtimeEnv.SWARM_SYNC_TOKEN || runtimeEnv.FOURSQUARE_SYNC_TOKEN || runtimeEnv.FOURSQUARE_PUSH_SECRET);
}

function getFoursquareClientId(runtimeEnv: RuntimeEnv) {
	return normalizeString(runtimeEnv.FOURSQUARE_CLIENT_ID || runtimeEnv.SWARM_CLIENT_ID);
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

function getCookieOptions() {
	return {
		path: "/",
		httpOnly: true,
		sameSite: "lax" as const,
		secure: true,
		maxAge: 60 * 10,
	};
}

export const GET: APIRoute = async ({ request, url, cookies }) => {
	const runtimeEnv: RuntimeEnv = env as unknown as RuntimeEnv;
	const adminToken = getAdminToken(runtimeEnv);
	const clientId = getFoursquareClientId(runtimeEnv);

	if (!adminToken || !clientId) {
		return new Response("Swarm/Foursquare is not configured.", { status: 503 });
	}

	const submittedToken = normalizeString(url.searchParams.get("token")) || request.headers.get("x-swarm-sync-token") || "";
	if (!submittedToken || submittedToken !== adminToken) {
		// Hide the endpoint by default.
		return new Response("Not found", { status: 404 });
	}

	const stateBytes = crypto.getRandomValues(new Uint8Array(18));
	const state = toHex(stateBytes);
	const sig = await signState(state, adminToken);

	cookies.set(STATE_COOKIE, state, getCookieOptions());
	cookies.set(SIG_COOKIE, sig, getCookieOptions());

	const redirectUri = getCallbackUrl(url.origin);
	const authorizeUrl = new URL(`${FOURSQUARE_AUTH_BASE}/authenticate`);
	authorizeUrl.searchParams.set("client_id", clientId);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	authorizeUrl.searchParams.set("state", state);

	return Response.redirect(authorizeUrl.toString(), 303);
};

