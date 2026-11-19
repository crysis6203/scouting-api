import { z } from "zod";
import { defineTool } from "../define.ts";

// Troop 0911 by default; set SCOUTING_ORG_GUID to use another unit
const DEFAULT_ORG_GUID = "fd33d07b-86d3-4f30-9743-004866f9fc59";

// Scouts BSA rank ids from the rank list
const RANKS: Record<string, [number, string]> = {
	scout: [1, "Scout"],
	tenderfoot: [2, "Tenderfoot"],
	"second class": [3, "Second Class"],
	"first class": [4, "First Class"],
	star: [5, "Star Scout"],
	"star scout": [5, "Star Scout"],
	life: [6, "Life Scout"],
	"life scout": [6, "Life Scout"],
	eagle: [7, "Eagle Scout"],
	"eagle scout": [7, "Eagle Scout"],
};

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the spec's schemas
type Any = any;

const clean = (s: unknown) =>
	String(s ?? "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const label = (r: Any) => {
	const a = clean(r.listNumber);
	const b = clean(r.requirementNumber);
	if (a && b && a.replace(/\.$/, "") === b) return a;
	return [a, b].filter(Boolean).join(" ") || "-";
};
const numKey = (r: Any): [number, string] => {
	const m = /^(\d+)([a-z]*)/i.exec(
		clean(r.listNumber) || clean(r.requirementNumber),
	);
	return m ? [Number(m[1]), m[2] ?? ""] : [Number.POSITIVE_INFINITY, ""];
};

export const remainingRequirements = defineTool({
	name: "remainingRequirements",
	title: "What a Scout still has to do for a rank",
	description:
		"Looks a youth up by name on the unit roster and returns a trimmed rank checklist: each requirement with done/not done, completion/marked/approved dates, and the full requirement text for items not yet done. Omit `rank` to use the youth's next unearned Scouts BSA rank. Use this instead of getYouthRankRequirements for questions like 'what does Nick have left for Star?'.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		name: z.string().describe("Youth's name, e.g. 'Nick Trusty'"),
		rank: z
			.string()
			.optional()
			.describe(
				"Scout, Tenderfoot, Second Class, First Class, Star, Life or Eagle. Defaults to the next unearned rank.",
			),
		organizationGuid: z
			.string()
			.optional()
			.describe("Unit GUID. Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const orgGuid =
			args.organizationGuid ??
			process.env["SCOUTING_ORG_GUID"] ??
			DEFAULT_ORG_GUID;

		const roster = await api.organizations.listOrganizationYouths({
			organizationGuid: orgGuid,
			includeExpired: false,
		});
		if (roster.error) return roster;

		// The roster lists a youth once per position, so de-duplicate
		const scouts = new Map<number, Any>();
		for (const m of roster.data.members) scouts.set(m.sbUserId, m);
		const q = args.name.toLowerCase().trim();
		const matches = [...scouts.values()].filter((m) => {
			const full = `${m.firstName} ${m.lastName}`.toLowerCase();
			const nick = `${m.nickName ?? ""} ${m.lastName}`.toLowerCase();
			return (
				String(m.personFullName ?? "")
					.toLowerCase()
					.includes(q) ||
				full.includes(q) ||
				nick.includes(q)
			);
		});
		if (matches.length !== 1) {
			return {
				data: {
					error:
						matches.length === 0
							? `No youth on the roster matches "${args.name}".`
							: `More than one match for "${args.name}". Use a fuller name.`,
					matches: matches.map((m) => m.personFullName),
				},
			};
		}
		const scout = matches[0];

		const fetchRank = (rankId: number) =>
			api.advancement.getYouthRankRequirements({
				userId: scout.sbUserId,
				rankId,
			});

		let rankId: number;
		let result: Any;
		if (args.rank) {
			const rank = RANKS[args.rank.toLowerCase().trim()];
			if (!rank) {
				return {
					data: {
						error: `Unknown rank "${args.rank}". Use Scout, Tenderfoot, Second Class, First Class, Star, Life or Eagle.`,
					},
				};
			}
			rankId = rank[0];
			result = await fetchRank(rankId);
		} else {
			rankId = 1;
			result = await fetchRank(rankId);
			while (!result.error && result.data.awarded && rankId < 7) {
				rankId += 1;
				result = await fetchRank(rankId);
			}
		}
		if (result.error) return result;
		const data = result.data;

		const reqs = [...(data.requirements ?? [])].sort((a: Any, b: Any) => {
			const [x, y] = [numKey(a), numKey(b)];
			return x[0] - y[0] || x[1].localeCompare(y[1]);
		});

		const items = reqs.map((r: Any) => {
			const done = Boolean(r.completed);
			const who = r.markedCompletedFirstName
				? `${r.markedCompletedFirstName} ${r.markedCompletedLastName ?? ""}`.trim()
				: null;
			const full = clean(r.name);
			return {
				number: label(r),
				parent: r.parentRequirementId ?? null,
				id: r.id,
				summary: clean(r.short) || full.slice(0, 120),
				// Full text only for what's left, to keep the answer small
				text: done
					? undefined
					: full.length > 700
						? `${full.slice(0, 697)}...`
						: full,
				done,
				started: Boolean(r.started),
				optional: Boolean(r.optional),
				childrenRequired: clean(r.childrenRequired) || undefined,
				monthsSinceLastRankRequired:
					clean(r.monthsSinceLastRankRequired) || undefined,
				dateStarted: day(r.dateStarted),
				dateCompleted: done ? day(r.dateCompleted) : undefined,
				markedCompletedDate: done ? day(r.markedCompletedDate) : undefined,
				markedCompletedBy: done ? who : undefined,
				leaderApprovedDate: day(r.leaderApprovedDate),
				status: r.status ?? undefined,
			};
		});

		// A parent with sub-items is done when Scoutbook says so, or its
		// required sub-items are done
		const kids = (id: number) => items.filter((i: Any) => i.parent === id);
		const isOpen = (i: Any): boolean => {
			if (i.done || i.optional) return false;
			const ch = kids(i.id);
			if (ch.length === 0) return true;
			if (i.status === "Leader Approved") return false;
			return ch.some(isOpen);
		};
		const remaining = items.filter(
			(i: Any) => kids(i.id).length === 0 && isOpen(i),
		);

		return {
			data: {
				scout: scout.personFullName,
				rank: data.name,
				rankId,
				rankStatus: data.status,
				awarded: Boolean(data.awarded),
				scoutbookPercentCompleted: data.percentCompleted,
				remainingCount: remaining.length,
				remaining: remaining.map((i: Any) => i.number),
				requirements: items,
				note: "'done' is what Scoutbook records; check leaderApprovedDate for approval. Parent items with sub-items roll up from their children.",
			},
		};
	},
});
