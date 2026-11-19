import { z } from "zod";
import { defineTool } from "../define.ts";
import { type Any, clean, findPeople, nameOf, norm, orgGuidOf, pool, rawGet } from "./troopCommon.ts";

const dayOf = (v: unknown) => {
	const t = String(v ?? "").slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

export const meritBadgeCounselors = defineTool({
	name: "meritBadgeCounselors",
	title: "Merit badge counselors in the troop",
	description:
		"Lists the troop's adults who are registered merit badge counselors, from each adult's counselor profile. Give `badge` (e.g. 'Cooking') for who counsels that badge, `name` for one adult's badge list, or neither for every counselor with how many badges each counsels. Includes email, phone and availability. Use for 'who can counsel Cooking?' or 'what badges does Mr. Beard counsel?'. Skips badges whose counselor approval has expired.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		badge: z.string().optional().describe("Merit badge name or part of it, e.g. 'Cooking'"),
		name: z.string().optional().describe("One adult, e.g. 'Beard'"),
		includeExpired: z.boolean().optional().describe("Also count badges past their expiry date. Default false."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const orgGuid = orgGuidOf(args.organizationGuid);
		const adultsRes = await api.organizations.listOrganizationAdults({ organizationGuid: orgGuid, includeExpired: false });
		if (adultsRes.error) return adultsRes;
		const byUser = new Map<number, Any>();
		for (const a of adultsRes.data.members as Any[]) if (!byUser.has(a.sbUserId)) byUser.set(a.sbUserId, a);
		let adults = [...byUser.values()];
		if (args.name) adults = findPeople(adults, args.name);
		if (!adults.length) return { data: { error: `No adult on the Troop roster matches "${args.name}".` } };

		const today = new Date().toISOString().slice(0, 10);
		const failures: string[] = [];
		const q = args.badge ? norm(args.badge) : "";
		const rows = await pool(adults, 3, async (a: Any) => {
			const r = await rawGet(api, `/advancements/v2/meritBadges/counselors/${a.memberId}/profile`);
			// 4xx means the adult has no counselor profile
			if (r.error !== undefined) {
				const st = r.response?.status;
				if (st && st >= 500) failures.push(nameOf(a));
				return null;
			}
			const p = r.data as Any;
			const badges = ((p.meritBadges ?? []) as Any[])
				.filter((b) => args.includeExpired || !dayOf(b.expiryDt) || (dayOf(b.expiryDt) as string) >= today)
				.map((b) => clean(b.meritBadgeName));
			if (!badges.length) return null;
			if (q && !badges.some((b) => norm(b).includes(q))) return null;
			return {
				counselor: nameOf(a),
				email: p.email?.email || null,
				phone: p.phone?.fullPhoneNumber ?? null,
				availability: clean(p.counselorAvailabilityLong) || null,
				registered: p.hasValidRegistration ?? null,
				badgeCount: badges.length,
				badges: q ? badges.filter((b) => norm(b).includes(q)) : args.name ? badges.sort() : undefined,
				scoutsCounseling: ((p.youths ?? []) as Any[]).length || undefined,
			};
		});
		const list = (rows.filter(Boolean) as Any[]).sort((x, y) => y.badgeCount - x.badgeCount);
		return {
			data: {
				count: list.length,
				counselors: list,
				failures: failures.length ? failures : undefined,
				note: "Only troop adults are checked. Counselors registered with the district or council who are not on the troop roster do not appear.",
			},
		};
	},
});
