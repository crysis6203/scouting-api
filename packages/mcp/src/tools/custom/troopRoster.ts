import { z } from "zod";
import { defineTool } from "../define.ts";
import {
	type Any,
	day,
	daysBetween,
	isAwarded,
	nameOf,
	orgGuidOf,
	pool,
	retry,
	scoutsBsaRanks,
	troopYouth,
} from "./troopCommon.ts";

const addYears = (d: Date, n: number) => {
	const x = new Date(d);
	x.setUTCFullYear(x.getUTCFullYear() + n);
	return x;
};
const parseDay = (v: unknown) => new Date(`${String(v).slice(0, 10)}T00:00:00Z`);

export const troopRoster = defineTool({
	name: "troopRoster",
	title: "Birthdays, Eagle age-out and registration expiry",
	description:
		"Roster reports from registration data. view=birthdays: upcoming birthdays (default next 30 days, or give `month` 1-12). view=ageOut: scouts 16 and older who are not yet Eagle, soonest 18th birthday first, with their rank. view=registration: scouts whose membership registration has expired, lapsed, or expires within `withinDays` (default 60). This is BSA registration, not health forms.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		view: z.enum(["birthdays", "ageOut", "registration"]),
		month: z.int().optional().describe("For birthdays: 1-12"),
		withinDays: z.int().optional().describe("Look-ahead window in days"),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const roster = await troopYouth(api, orgGuidOf(args.organizationGuid), true);
		if ("error" in roster) return roster.error;
		const now = new Date();
		const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);

		const people = roster.scouts
			.map((s: Any) => {
				const info = s.registrarInfo;
				if (!info?.dateOfBirth) return null;
				const dob = parseDay(info.dateOfBirth);
				let next = new Date(Date.UTC(today.getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate()));
				if (next < today) next = addYears(next, 1);
				const age = today.getUTCFullYear() - dob.getUTCFullYear() -
					(next.getUTCFullYear() === today.getUTCFullYear() ? 1 : 0);
				return { s, info, dob, next, age, turns18: addYears(dob, 18) };
			})
			.filter(Boolean) as Any[];

		if (args.view === "birthdays") {
			const within = args.withinDays ?? 30;
			const rows = people
				.filter((p) =>
					args.month
						? p.dob.getUTCMonth() + 1 === args.month
						: daysBetween(today, p.next) <= within,
				)
				.sort((a, b) => a.next.getTime() - b.next.getTime())
				.map((p) => ({
					scout: nameOf(p.s),
					birthday: day(p.next.toISOString()),
					turning: p.age + 1,
					inDays: daysBetween(today, p.next),
				}));
			return { data: { scouts: rows } };
		}

		if (args.view === "registration") {
			const within = args.withinDays ?? 60;
			const rows = people
				.map((p) => ({
					scout: nameOf(p.s),
					expires: day(p.info.registrationExpireDt),
					daysLeft: daysBetween(today, parseDay(p.info.registrationExpireDt)),
					status: p.info.registrationStatus,
					expired: Boolean(p.info.isExpired),
					lapsed: Boolean(p.info.isLapsed),
					renewal: p.info.renewalStatus,
				}))
				.filter((r) => r.expired || r.lapsed || r.daysLeft <= within)
				.sort((a, b) => a.daysLeft - b.daysLeft);
			return { data: { scouts: rows } };
		}

		// ageOut
		const older = people.filter((p) => p.age >= 16 && p.turns18 > today);
		const rows = await pool(older, 6, async (p: Any) => {
			const r = await retry(() => api.advancement.listYouthRanks({ userId: p.s.sbUserId }));
			const ranks = r.error ? [] : scoutsBsaRanks(r.data);
			const awarded = ranks.filter(isAwarded);
			const current = awarded[awarded.length - 1];
			if (current?.name === "Eagle Scout") return null;
			return {
				scout: nameOf(p.s),
				age: p.age,
				turns18: day(p.turns18.toISOString()),
				daysLeft: daysBetween(today, p.turns18),
				rank: current?.name ?? (r.error ? "unknown" : "No rank yet"),
			};
		});
		return {
			data: {
				scouts: rows.filter(Boolean).sort((a: Any, b: Any) => a.daysLeft - b.daysLeft),
				note: "Eagle requirements must be completed before the 18th birthday (the board of review can follow within the allowed period).",
			},
		};
	},
});
