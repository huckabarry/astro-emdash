import { fileURLToPath } from "node:url";
import { definePlugin } from "emdash";
import type {
	EmailDeliverEvent,
	PluginContext,
	PluginDescriptor,
	ResolvedPlugin,
} from "emdash";

const PLUGIN_ID = "afterword-email";
const VERSION = "0.1.0";

export function afterwordEmailPlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: VERSION,
		format: "native",
		entrypoint: fileURLToPath(new URL("./index.ts", import.meta.url)),
	};
}

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: ["email:provide", "network:fetch"],
		allowedHosts: ["api.mailgun.net"],
		hooks: {
			"email:deliver": {
				exclusive: true,
				handler: mailgunEmailDeliver,
			},
		},
	});
}

export default createPlugin;

async function mailgunEmailDeliver(
	event: EmailDeliverEvent,
	ctx: PluginContext,
): Promise<void> {
	if (!ctx.http) {
		throw new Error("Afterword email plugin requires network:fetch.");
	}

	const apiKey = await readSetting(ctx, "apiKey", "MAILGUN_API_KEY");
	const domain = await readSetting(ctx, "domain", "MAILGUN_DOMAIN");
	const fromEmail = await readSetting(ctx, "fromEmail", "MAILGUN_FROM_EMAIL");
	const fromName = await readSetting(ctx, "fromName", "MAILGUN_FROM_NAME");
	const replyTo = await readSetting(ctx, "replyTo", "MAILGUN_REPLY_TO");

	if (!apiKey) {
		throw new Error("Mailgun email provider is missing its API key.");
	}

	if (!domain) {
		throw new Error("Mailgun email provider is missing its domain.");
	}

	if (!fromEmail) {
		throw new Error("Mailgun email provider is missing its From Email setting.");
	}

	const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
	const params = new URLSearchParams();
	params.set("from", from);
	params.set("to", event.message.to);
	params.set("subject", event.message.subject);
	params.set("text", event.message.text);
	if (event.message.html) params.set("html", event.message.html);
	if (replyTo) params.set("h:Reply-To", replyTo);

	const response = await ctx.http.fetch(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: params.toString(),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Mailgun delivery failed (${response.status}): ${body}`);
	}

	ctx.log.info("Email delivered through Mailgun", {
		to: event.message.to,
		source: event.source,
	});
}

async function readSetting(
	ctx: PluginContext,
	key: string,
	envKey: string,
): Promise<string> {
	const envValue = process.env?.[envKey];
	if (typeof envValue === "string" && envValue.trim()) {
		return envValue.trim();
	}
	const value = await ctx.kv.get(`settings:${key}`);
	return typeof value === "string" ? value.trim() : "";
}
