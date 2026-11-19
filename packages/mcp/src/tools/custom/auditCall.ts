import { z } from "zod";
import { defineTool } from "../define.ts";
import { operations as apiOperations } from "../generated/api.scouting.org/index.ts";
import { operations as scoutConnectOperations } from "../generated/scoutconnect-api.scouting.org/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: audits raw, unvalidated responses
type Any = any;

type Leaf = { path: PropertyKey[]; message: string };

// Union errors nest one issue list per branch. Keep the branch with the
// fewest problems, since that is the one the data was closest to.
function leaves(issues: Any[], base: PropertyKey[] = []): Leaf[] {
	return issues.flatMap((i): Leaf[] => {
		const path = [...base, ...(i.path ?? [])];
		if (i.code === "invalid_union" && Array.isArray(i.errors)) {
			const branches = i.errors.map((b: Any[]) => leaves(b, path));
			return branches.sort((a: Leaf[], b: Leaf[]) => a.length - b.length)[0] ?? [];
		}
		if (i.code === "unrecognized_keys") {
			return [{ path, message: `unlisted fields: ${(i.keys ?? []).join(", ")}` }];
		}
		return [{ path, message: i.message }];
	});
}

const norm = (path: PropertyKey[]) =>
	path.map((p) => (typeof p === "number" ? "[]" : `.${String(p)}`)).join("").replace(/^\./, "");

const typeOf = (v: unknown) =>
	v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

function inventory(v: unknown, path: string, into: Map<string, Map<string, number>>) {
	const t = typeOf(v);
	const m = into.get(path) ?? new Map<string, number>();
	m.set(t, (m.get(t) ?? 0) + 1);
	into.set(path, m);
	if (Array.isArray(v)) {
		for (const x of v) inventory(x, `${path}[]`, into);
	} else if (v && typeof v === "object") {
		for (const [k, x] of Object.entries(v)) {
			inventory(x, path ? `${path}.${k}` : k, into);
		}
	}
}

// Finds `scouting.<sdk>.<tag>.<operation>` without knowing the tag. Tags are
// getters on the SDK's prototype, so Object.keys would miss them.
function findMethod(root: Any, name: string): ((...a: Any[]) => Promise<Any>) | undefined {
	for (const sdk of Object.values(root) as Any[]) {
		const proto = Object.getPrototypeOf(sdk);
		for (const tag of Object.getOwnPropertyNames(proto)) {
			if (tag === "constructor") continue;
			let group: Any;
			try {
				group = sdk[tag];
			} catch {
				continue;
			}
			if (group && typeof group[name] === "function") {
				return group[name].bind(group);
			}
		}
	}
	return undefined;
}

export const auditCall = defineTool({
	name: "auditCall",
	title: "Debug: audit one operation's raw response against the spec",
	description:
		"Debug only. Calls one operation by name with the given arguments, checks the raw response against the spec's strict Zod schema, and returns the mismatches grouped by field path plus the JSON types seen at every path. Never returns field values.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		operation: z.string().describe("Operation name, e.g. listUnitParents"),
		args: z.record(z.string(), z.unknown()).optional(),
		fieldFilter: z.string().optional().describe("Only list type paths containing this text"),
	}),
	call: async (scouting, args) => {
		const op = [...apiOperations, ...scoutConnectOperations].find(
			(o) => o.name === args.operation,
		);
		if (!op) return { data: { error: `no operation ${args.operation}` } };
		const input = op.input ? op.input.parse(args.args ?? {}) : (args.args ?? {});
		// The generated client validates responses itself and returns a ZodError
		// instead of the data. Its call options come after its own validator, so
		// passing one here turns that off and gives the raw response.
		const raw = { responseValidator: async (d: unknown) => d };
		const method = findMethod(scouting, op.name);
		const res: Any = method
			? await method(input, raw)
			: { error: { note: "client method not found; validator was on" }, ...(await op.call(scouting, input)) };
		if (res.error) {
			return {
				data: {
					status: res.response?.status,
					error: JSON.stringify(res.error).slice(0, 300),
				},
			};
		}
		const mismatches = new Map<string, number>();
		const r = op.output?.safeParse(res.data);
		if (r && !r.success) {
			for (const l of leaves(r.error.issues)) {
				const key = `${norm(l.path)} :: ${l.message}`;
				mismatches.set(key, (mismatches.get(key) ?? 0) + 1);
			}
		}
		const inv = new Map<string, Map<string, number>>();
		inventory(res.data, "", inv);
		const f = args.fieldFilter;
		return {
			data: {
				valid: r ? r.success : "no output schema",
				mismatches: Object.fromEntries(
					[...mismatches].sort((a, b) => b[1] - a[1]),
				),
				types: Object.fromEntries(
					[...inv]
						.filter(([p]) => !f || p.includes(f))
						.map(([p, m]) => [p || "(root)", Object.fromEntries(m)]),
				),
			},
		};
	},
});
