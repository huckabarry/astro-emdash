import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { atprotoPlugin } from "@emdash-cms/plugin-atproto";
import { embedsPlugin } from "@emdash-cms/plugin-embeds";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { afterwordEmailPlugin } from "./src/plugins/afterword-email/index";

export default defineConfig({
	site: "https://afterword.blog",
	output: "server",
	adapter: cloudflare(),
	prefetch: {
		prefetchAll: false,
	},
	fonts: [
		{
			provider: fontProviders.local(),
			name: "Afterword Fira Sans",
			cssVariable: "--font-sans",
			fallbacks: ["sans-serif"],
			display: "optional",
			options: {
				variants: [
					{ src: ["./src/assets/fonts/fira-sans-latin-400-normal.woff2"], weight: 400, style: "normal" },
					{ src: ["./src/assets/fonts/fira-sans-latin-600-normal.woff2"], weight: 600, style: "normal" },
					{ src: ["./src/assets/fonts/fira-sans-latin-800-normal.woff2"], weight: 800, style: "normal" },
					{ src: ["./src/assets/fonts/fira-sans-latin-800-normal.woff2"], weight: 900, style: "normal" },
				],
			},
		},
		{
			provider: fontProviders.local(),
			name: "Afterword IBM Plex Mono",
			cssVariable: "--font-mono",
			fallbacks: ["monospace"],
			display: "optional",
			options: {
				variants: [
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-400-normal.woff2"], weight: 400, style: "normal" },
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-400-italic.woff2"], weight: 400, style: "italic" },
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-500-normal.woff2"], weight: 500, style: "normal" },
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-500-italic.woff2"], weight: 500, style: "italic" },
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-600-normal.woff2"], weight: 600, style: "normal" },
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-600-italic.woff2"], weight: 600, style: "italic" },
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-700-normal.woff2"], weight: 700, style: "normal" },
					{ src: ["./src/assets/fonts/ibm-plex-mono-latin-700-italic.woff2"], weight: 700, style: "italic" },
				],
			},
		},
	],
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
