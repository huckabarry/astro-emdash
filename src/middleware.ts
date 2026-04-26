import { defineMiddleware } from "astro:middleware";

const SESSION_COOKIE_NAME = "astro-session";
const PRIMARY_HOSTNAME = "afterword.blog";

function hasSessionCookie(cookieHeader: string | null): boolean {
	if (!cookieHeader) return false;

	return cookieHeader
		.split(";")
		.map((part) => part.trim())
		.some((part) => part === SESSION_COOKIE_NAME || part.startsWith(`${SESSION_COOKIE_NAME}=`));
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname, origin, protocol, hostname, search } = context.url;
	const hasSession = hasSessionCookie(context.request.headers.get("cookie"));

	// Ensure WebAuthn/passkeys can work by forcing HTTPS for human traffic.
	// (We allow plain HTTP for ACME challenge probes.)
	if (protocol === "http:" && !pathname.startsWith("/.well-known/acme-challenge/")) {
		const httpsUrl = new URL(`https://${hostname}${pathname}${search}`);
		return context.redirect(httpsUrl.toString(), 301);
	}

	// Avoid passkey origin mismatches by redirecting admin traffic away from the workers.dev hostname.
	if (hostname.endsWith(".workers.dev") && pathname.startsWith("/_emdash/")) {
		const target = new URL(`https://${PRIMARY_HOSTNAME}${pathname}${search}`);
		return context.redirect(target.toString(), 302);
	}

	if (pathname === "/_emdash/api/auth/me" && !hasSession) {
		return Response.json(
			{ error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" } },
			{
				status: 401,
				headers: {
					"Cache-Control": "private, no-store",
				},
			},
		);
	}

	const isAdminRoute = pathname.startsWith("/_emdash/admin");
	const isLoginRoute = pathname.startsWith("/_emdash/admin/login");
	const isSetupRoute = pathname.startsWith("/_emdash/admin/setup");

	if (isAdminRoute && !isLoginRoute && !isSetupRoute && !hasSession) {
		const loginUrl = new URL("/_emdash/admin/login", origin);
		loginUrl.searchParams.set("redirect", pathname);
		return context.redirect(loginUrl.toString());
	}

	return next();
});
