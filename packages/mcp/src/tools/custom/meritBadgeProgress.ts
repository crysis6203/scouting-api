import { z } from "zod";
import { defineTool } from "../define.ts";
import { type Any, clean, day, nameOf, norm, orgGuidOf, troopYouth } from "./troopCommon.ts";

export const meritBadgeProgress = defineTool({
	name: "meritBadgeProgress",
	title: "Who is working on a merit badge",
	description:
		"For one merit badge, lists the troop's scouts who have started it (and not yet earned or been leader approved for it) with the requirements each has completed. Give `requirement` (e.g. '8') to see only scouts who have started the badge but not completed that requirement. Use for 'who has started Communication and still needs requirement 8?'. Looks the badge up by name and handles the BSA member IDs this API needs.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		badge: z.string().describe("Merit badge name, e.g. 'Communication'"),
		requirement: z
			.string()
			.optional()
			.describe("Requirement number as Scoutbook lists it, e.g. '8' or '7b'"),
		includeEarned: z
			.boolean()
			.optional()
			.describe("Also list scouts who have already earned it. Default false."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const orgGuid = orgGuidOf(args.organizationGuid);

		const list = await api.advancement.listMeritBadgesV2({ status: "active" });
		if (list.error) return list;
		const q = norm(args.badge);
		const all = ((list.data as Any).meritBadges ?? list.data) as Any[];
		const hits = all.filter((b) => norm(b.name) === q);
		const found = hits.length ? hits : all.filter((b) => norm(b.name).includes(q));
		if (found.length !== 1) {
			return {
				data: {
					error:
						found.length === 0
							? `No merit badge matches "${args.badge}".`
							: `More than one merit badge matches "${args.badge}".`,
					matches: found.map((b) => b.name),
				},
			};
		}
		const badge = found[0];
		const badgeId = Number(badge.id);

		const [defs, roster] = await Promise.all([
			api.advancement.getMeritBadgeRequirements({ meritBadgeId: badgeId }),
			troopYouth(api, orgGuid),
		]);
		if (defs.error) return defs;
		if ("error" in roster) return roster.error;

		// This call keys on the BSA member id, not the Scoutbook user id
		const byMember = new Map<number, Any>();
		for (const s of roster.scouts) byMember.set(Number(s.memberId), s);
		const memberIds = [...byMember.keys()];
		const label = new Map<string, string>();
		for (const r of (defs.data.requirements ?? []) as Any[]) {
			const n = clean(r.listNumber) || clean(r.requirementNumber);
			label.set(String(r.id), clean(r.requirementNumber) || n.replace(/[().]/g, ""));
		}

		const progress: Any[] = [];
		for (let i = 0; i < memberIds.length; i += 25) {
			const res = await api.advancement.listMemberMeritBadgeRequirements({
				organizationGuid: orgGuid,
				meritBadgeId: badgeId,
				memberId: memberIds.slice(i, i + 25),
			});
			if (res.error) return res;
			progress.push(...(res.data as Any[]));
		}

		const want = norm(args.requirement ?? "").replace(/\.$/, "");
		const rows = [];
		const couldNotCheck: string[] = [];
		for (const p of progress) {
			const s = byMember.get(Number(p.memberId));
			if (!s) continue;
			const reqs: Any[] = p.requirements ?? [];
			const completed = reqs.filter((r) => r.dateCompleted || r.leaderApprovedDate);
			const earned =
				Boolean(p.dateEarned) || p.status === "Awarded" || p.status === "Leader Approved";
			const started = Boolean(p.status) || reqs.some((r) => r.status || r.dateCompleted);
			if (!started) continue;
			if (earned && !args.includeEarned) continue;
			const done = completed.map((r) => label.get(String(r.id)) ?? String(r.id));
			// Scouts who started an older version of the badge have requirement ids that
			// do not match today's numbering, so a requirement check on them is unreliable
			if (want && completed.some((r) => !label.has(String(r.id)))) {
				couldNotCheck.push(nameOf(s));
				continue;
			}
			if (want) {
				const target = reqs.find((r) => norm(label.get(String(r.id))) === want);
				const targetDone = target && (target.dateCompleted || target.leaderApprovedDate);
				if (targetDone) continue;
			}
			rows.push({
				scout: nameOf(s),
				status: earned ? "Earned" : (p.status ?? "Started"),
				completedRequirements: done,
				lastCompleted: completed
					.map((r) => day(r.dateCompleted))
					.filter(Boolean)
					.sort()
					.pop(),
			});
		}
		return {
			data: {
				badge: badge.name,
				requirementFilter: args.requirement,
				count: rows.length,
				scouts: rows,
				couldNotCheck: couldNotCheck.length ? couldNotCheck : undefined,
				note: "Leader Approved counts as earned. couldNotCheck lists scouts who worked on an older version of the badge, whose requirements cannot be matched to the current numbers. Started means Scoutbook has a status or a completed requirement for the scout. A requirement that offers choices (such as 'do ONE of the following') shows only the parts completed.",
			},
		};
	},
});
