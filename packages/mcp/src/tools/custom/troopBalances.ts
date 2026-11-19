import { z } from "zod";
import { defineTool } from "../define.ts";
import { type Any, findPeople, nameOf, orgGuidOf, rawGet, troopYouth } from "./troopCommon.ts";

const money = (n: number) => Math.round(n * 100) / 100;

export const troopBalances = defineTool({
	name: "troopBalances",
	title: "Scout account balances",
	description:
		"Current Scoutbook account balance for each scout, as on a scout's profile page. A negative balance means the scout owes money to the troop; a positive one is credit. Give `name` for one scout, or view=owing for everyone with a negative balance (largest first), view=credit for positive balances, view=all for everyone, which also totals them. Current balances only, not payment history. Only scouts on the current troop roster are counted.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		name: z.string().optional().describe("One scout, e.g. 'Keaton'."),
		view: z.enum(["owing", "credit", "all"]).optional().describe("Defaults to owing when no name is given."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const guid = orgGuidOf(args.organizationGuid);
		const today = new Date().toISOString().slice(0, 10);
		// The endpoint lists every account in the unit, including former members and
		// adults, so keep only scouts on the current roster
		const roster = await troopYouth(api, guid);
		if ("error" in roster) return roster.error;
		const current = new Map<number, Any>(roster.scouts.map((s: Any) => [s.sbUserId, s]));
		// The endpoint insists on a date range; a wide one returns the running balance
		const res = await rawGet(api, `/advancements/v2/organization/${guid}/balanceDetails`, {
			fromDate: "2000-01-01",
			toDate: today,
		});
		if (res.error !== undefined) {
			return { data: { status: res.response?.status, error: res.error } };
		}
		const rows = (res.data as Any[])
			.filter((m) => current.has(m.userId))
			.map((m) => ({
				firstName: m.firstName,
				middleName: m.middleName,
				nickName: m.nickName,
				lastName: m.lastName,
				personFullName: `${m.firstName} ${m.lastName}`,
				scout: nameOf(current.get(m.userId)),
				balance: money(m.balanceDetails?.balance ?? 0),
			}));
		const show = (x: Any) => ({ scout: x.scout, balance: x.balance });
		if (args.name) {
			const hit = findPeople(rows, args.name);
			if (!hit.length) return { data: { error: `No scout with an account matches "${args.name}".` } };
			return { data: { balances: hit.map(show), note: "Negative means the scout owes the troop." } };
		}
		const view = args.view ?? "owing";
		const total = (l: Any[]) => money(l.reduce((a, x) => a + x.balance, 0));
		if (view === "owing") {
			const l = rows.filter((x) => x.balance < 0).sort((a, b) => a.balance - b.balance);
			return { data: { count: l.length, totalOwed: total(l), scouts: l.map(show), note: "Negative means the scout owes the troop." } };
		}
		if (view === "credit") {
			const l = rows.filter((x) => x.balance > 0).sort((a, b) => b.balance - a.balance);
			return { data: { count: l.length, totalCredit: total(l), scouts: l.map(show) } };
		}
		const l = [...rows].sort((a, b) => a.balance - b.balance);
		return { data: { count: l.length, netTotal: total(l), scouts: l.map(show) } };
	},
});
