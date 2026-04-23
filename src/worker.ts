import handler from "@astrojs/cloudflare/entrypoints/server";

export { PluginBridge } from "@emdash-cms/cloudflare/sandbox";

export default {
	async fetch(request: Request, env: any, ctx: ExecutionContext) {
		return handler.fetch(request, env, ctx);
	},
};
