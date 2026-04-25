import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { atprotoPlugin } from "@emdash-cms/plugin-atproto";
import { embedsPlugin } from "@emdash-cms/plugin-embeds";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { afterwordEmailPlugin } from "./src/plugins/afterword-email/index";

export default defineConfig({
	site: "https://afterword.blog",
	output: "server",
	adapter: cloudflare(),
	prefetch: false,
	i18n: {
		defaultLocale: "en",
		locales: ["en", "it"],
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			siteUrl: "https://afterword.blog",
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [
				atprotoPlugin(),
				formsPlugin(),
				webhookNotifierPlugin(),
				afterwordEmailPlugin(),
				embedsPlugin(),
			],
		}),
	],
	devToolbar: { enabled: false },
});
