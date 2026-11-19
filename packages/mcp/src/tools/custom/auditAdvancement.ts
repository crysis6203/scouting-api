import { z } from "zod";
import { defineTool } from "../define.ts";
import { operations as apiOperations } from "../generated/api.scouting.org/index.ts";
import { findMethod, inventory, leaves, norm } from "./auditCall.ts";

// biome-ignore lint/suspicious/noExplicitAny: audits raw, unvalidated responses
type Any = any;

const DEFAULT_ORG_GUID = "fd33d07b-86d3-4f30-9743-004866f9fc59";
const PER_SCOUT = [
	"listYouthRanks",
	"listYouthMeritBadges",
	"listYouthAdventures",
	"listYouthAwards",
	"listYouthLeadershipPositionHistory",
];

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
	let i = 0;
	await Promise.all(
		Array.from({ length: size }, async () => {
			while (i < items.length) await fn(items[i++] as T);
		}),
	);
}

// Collects Scouts BSA rank ids (programId 2) from a listYouthRanks response, so
// rank requirements can be fetched. Rank objects carry `id`, not `rankId`.
function rankIds(v: unknown, into: Set<number>) {
	if (Array.isArray(v)) for (const x of v) rankIds(x, into);
	else if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		if (Array.isArray(o["ranks"]) && (o["programId"] === 2 || o["program"] === "Scouts BSA")) {
			for (const r of o["ranks"] as Array<Record<string, unknown>>) {
				if (typeof r?.["id"] === "number") into.add(r["id"]);
			}
		} else for (const x of Object.values(o)) rankIds(x, into);
	}
}

export const auditAdvancement = defineTool({
	name: "auditAdvancement",
	title: "Debug: audit advancement responses for troop scouts",
	description:
		"Debug only. For a sample of the troop's scouts, calls the youth rank, merit badge, adventure, award, leadership history and rank requirement calls, checks each raw response against the spec's strict Zod schema, and returns the mismatches by field path, the fields seen with more than one JSON type, and arrays never seen non-empty. Returns scout IDs but never names or values.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911"),
		maxScouts: z.int().optional().describe("Scouts to sample. Default 20"),
		offset: z.int().optional().describe("Skip this many scouts first. Default 0"),
		includeTypes: z.boolean().optional().describe("Also return the type of every path"),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const org = args.organizationGuid ?? process.env["SCOUTING_ORG_GUID"] ?? DEFAULT_ORG_GUID;
		const raw = { responseValidator: async (d: unknown) => d };
		const outputOf = (name: string) => apiOperations.find((o) => o.name === name)?.output;

		const roster = await api.organizations.listOrganizationYouths({
			organizationGuid: org,
			includeExpired: false,
			includeRegistrationDetails: false,
		});
		if (roster.error) return roster;
		const ids = [...new Set<number>(roster.data.members.map((m: Any) => m.sbUserId))].sort(
			(a, b) => a - b,
		);
		const off = args.offset ?? 0;
		const max = args.maxScouts ?? 20;
		// Spread the sample across the roster, not just the first scouts
		const stride = Math.max(1, Math.floor((ids.length - off) / max));
		const sample = Array.from({ length: max }, (_, i) => ids[off + i * stride]).filter(
			(x): x is number => x !== undefined,
		);

		const mism = new Map<string, { count: number; scouts: Set<number> }>();
		const inv = new Map<string, Map<string, number>>();
		const failures: string[] = [];

		const run = async (op: string, params: Record<string, unknown>, who: number, extra?: string) => {
			const method = findMethod(scouting, op);
			if (!method) {
				failures.push(`${op}: client method not found`);
				return undefined;
			}
			const res: Any = await method(params, raw);
			if (res.error) {
				failures.push(`${op} ${who}${extra ?? ""}: ${res.response?.status} ${JSON.stringify(res.error).slice(0, 100)}`);
				return undefined;
			}
			const r = outputOf(op)?.safeParse(res.data);
			if (r && !r.success) {
				for (const l of leaves(r.error.issues)) {
					const key = `${op}:${norm(l.path)} :: ${l.message}`;
					const m = mism.get(key) ?? { count: 0, scouts: new Set<number>() };
					m.count++;
					if (m.scouts.size < 3) m.scouts.add(who);
					mism.set(key, m);
				}
			}
			inventory(res.data, op, inv);
			return res.data;
		};

		const ranks = new Map<number, Set<number>>();
		await pool(sample, 5, async (userId) => {
			for (const op of PER_SCOUT) {
				const data = await run(op, { userId }, userId);
				if (op === "listYouthRanks" && data) {
					const set = new Set<number>();
					rankIds(data, set);
					ranks.set(userId, set);
				}
			}
		});

		// Requirements for the ranks each sampled scout has, capped for time
		const reqJobs = [...ranks].flatMap(([userId, set]) =>
			[...set].slice(0, 3).map((rankId) => ({ userId, rankId })),
		);
		await pool(reqJobs.slice(0, 60), 5, async ({ userId, rankId }) => {
			await run("getYouthRankRequirements", { userId, rankId }, userId, `/rank ${rankId}`);
		});

		const multi: Record<string, Record<string, number>> = {};
		const empty: string[] = [];
		for (const [p, m] of inv) {
			const types = [...m.keys()].filter((t) => t !== "(never non-empty)");
			if (types.length > 1) multi[p] = Object.fromEntries(m);
			if (p.endsWith("[]") && m.size === 0) empty.push(p);
		}
		return {
			data: {
				rosterSize: ids.length,
				scoutsSampled: sample.length,
				rankRequirementCalls: Math.min(reqJobs.length, 60),
				failures: failures.slice(0, 20),
				failureCount: failures.length,
				mismatches: Object.fromEntries(
					[...mism]
						.sort((a, b) => b[1].count - a[1].count)
						.map(([k, v]) => [k, { count: v.count, exampleScouts: [...v.scouts] }]),
				),
				fieldsWithSeveralTypes: multi,
				...(args.includeTypes
					? { types: Object.fromEntries([...inv].map(([p, m]) => [p, Object.fromEntries(m)])) }
					: {}),
			},
		};
	},
});
