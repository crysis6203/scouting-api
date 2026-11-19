import { z } from "zod";
import { defineTool } from "../define.ts";
import { type Any, retry } from "./troopCommon.ts";
import { inventory } from "./auditCall.ts";

// Debug only. A read-only GET against any api.scouting.org path with the
// signed-in session, for finding what an endpoint returns before it is in the
// spec. By default it returns field names and JSON types, never values.
export const auditRaw = defineTool({
	name: "auditRaw",
	title: "Debug: GET any api.scouting.org path",
	description:
		"Debug only, read-only. Sends a GET to an api.scouting.org path (for example /advancements/v2/organization/<guid>/balanceDetails) and returns the status and the field paths with their JSON types. Set includeValues to also get the response body, cut to maxChars. Use to learn the shape of endpoints that are not in the spec yet.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		path: z.string().describe("Path starting with /, with IDs filled in"),
		query: z
			.record(z.string(), z.string())
			.optional()
			.describe("Query string parameters"),
		includeValues: z.boolean().optional().describe("Return the body too. Default false."),
		maxChars: z.int().optional().describe("Body length cap when includeValues. Default 8000."),
		fieldFilter: z.string().optional().describe("Only list type paths containing this text"),
	}),
	call: async (scouting, args) => {
		if (!/^\/[A-Za-z0-9/_\-.]+$/.test(args.path) || args.path.includes("..")) {
			return { data: { error: "Path must start with / and use only letters, digits and / _ - ." } };
		}
		const api = scouting.api as Any;
		// Any tag group carries the SDK's configured client, with the session token
		const group = api.advancement ?? api.organizations;
		const client = group?.client;
		if (!client?.get) return { data: { error: "No HTTP client available on the SDK." } };

		const res = await retry(() =>
			client.get({
				url: args.path,
				query: args.query,
				security: [{ scheme: "bearer", type: "http" }],
				// Take the body as it comes, whatever the spec says
				responseValidator: undefined,
				parseAs: "json",
			}),
		);
		const status = res.response?.status;
		if (res.error !== undefined) {
			return { data: { status, error: typeof res.error === "string" ? res.error.slice(0, 500) : res.error } };
		}
		const types = new Map<string, Map<string, number>>();
		inventory(res.data, "", types);
		const out: Record<string, Record<string, number>> = {};
		for (const [p, m] of types) {
			if (args.fieldFilter && !p.includes(args.fieldFilter)) continue;
			out[p || "(root)"] = Object.fromEntries(m);
		}
		const body = args.includeValues
			? JSON.stringify(res.data).slice(0, args.maxChars ?? 8000)
			: undefined;
		return { data: { status, types: out, body } };
	},
});
