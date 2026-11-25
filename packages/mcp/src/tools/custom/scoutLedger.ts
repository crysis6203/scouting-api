import { z } from "zod";
import { defineTool } from "../define.ts";
import {
	type Any,
	clean,
	day,
	findPeople,
	nameOf,
	norm,
	orgGuidOf,
	rawGet,
	troopYouth,
} from "./troopCommon.ts";

const money = (n: number) => Math.round(n * 100) / 100;
const total = (rows: Any[]) =>
	money(rows.reduce((a, r) => a + (r.amount ?? 0), 0));
const ofType = (rows: Any[], t: string) =>
	rows.filter((r) => r.paymentType === t);

// An Online payment is only money in hand once the card gateway reports
// "succeeded". One that was started and never finished stays in the log with
// no gateway status, and Scoutbook leaves it out of the balance.
const unfinishedOnline = (r: Any) =>
	r.paymentType === "Online" && r.paymentGatewayStatus !== "succeeded";
const counts = (r: Any) => !r.deleted && !unfinishedOnline(r);

// Charges are stored as negative amounts; payments and credits as positive ones
function totals(rows: Any[]) {
	const live = rows.filter(counts);
	const pending = rows.filter((r) => !r.deleted && unfinishedOnline(r));
	return {
		entries: live.length,
		deletedEntries: rows.filter((r) => r.deleted).length,
		charges: total(ofType(live, "Charge")),
		payments: total(ofType(live, "Payment")),
		onlinePayments: total(ofType(live, "Online")),
		credits: total(ofType(live, "Credit")),
		unfinishedOnlinePayments: pending.length,
		unfinishedOnlineAmount: total(pending),
		ledgerBalance: total(live),
		ledgerBalanceWithDeleted: total(rows.filter((r) => !unfinishedOnline(r))),
	};
}

const line = (r: Any, running?: number) => ({
	paymentLogId: r.paymentLogId,
	date: day(r.logDate),
	type: r.paymentType,
	amount: money(r.amount ?? 0),
	...(running === undefined ? {} : { runningBalance: running }),
	description: clean(r.description),
	notes: clean(r.notes) || undefined,
	category: r.category || undefined,
	calendarEventId: r.calendarEventId ?? undefined,
	transactionId: r.transactionId ?? undefined,
	gatewayStatus: r.paymentGatewayStatus ?? undefined,
	notCounted: unfinishedOnline(r)
		? "online payment started but not completed; not in the balance"
		: undefined,
	deleted: r.deleted || undefined,
});

export const scoutLedger = defineTool({
	name: "scoutLedger",
	title: "Scout account ledger",
	description:
		"Read-only. Every dated charge, payment and credit behind a scout's Scoutbook account balance, from the unit payment log. Charges are negative amounts; payments and credits are positive. Online payments count only when the card gateway reports succeeded; ones started and never finished are listed as unfinished and left out of the balance, as Scoutbook does. view=ledger (needs `name`): that scout's entries oldest first with a running balance, totals by type, and the reported balance for comparison. view=owing: scouts with a negative balance, each with their largest charges and latest payment, to show what the balance is made of. view=summary: every scout's charges, payments, credits and balance. view=check: problems to look at: ledger totals that differ from the reported balance, possible duplicate charges, and entries marked deleted. Only scouts on the current troop roster are counted. Changes nothing in Scoutbook.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		name: z
			.string()
			.optional()
			.describe("One scout, e.g. 'Cooper'. Needed for view=ledger."),
		view: z
			.enum(["ledger", "owing", "summary", "check"])
			.optional()
			.describe("Defaults to ledger when a name is given, otherwise check."),
		since: z
			.string()
			.optional()
			.describe(
				"For view=ledger: only list entries on or after this date (YYYY-MM-DD). Balances still count all history.",
			),
		includeDeleted: z
			.boolean()
			.optional()
			.describe(
				"For view=ledger: also list entries marked deleted. Default false.",
			),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const guid = orgGuidOf(args.organizationGuid);
		const today = new Date().toISOString().slice(0, 10);
		const roster = await troopYouth(api, guid);
		if ("error" in roster) return roster.error;
		const current = new Map<number, Any>(
			roster.scouts.map((s: Any) => [s.sbUserId, s]),
		);

		// Both endpoints insist on a date range; a wide one returns the full history
		const range = { fromDate: "2000-01-01", toDate: today };
		const [logs, bal] = await Promise.all([
			rawGet(api, `/advancements/v2/organization/${guid}/paymentLogs`, range),
			rawGet(
				api,
				`/advancements/v2/organization/${guid}/balanceDetails`,
				range,
			),
		]);
		for (const res of [logs, bal]) {
			if (res.error !== undefined)
				return { data: { status: res.response?.status, error: res.error } };
		}
		const reported = new Map<number, number>(
			(bal.data as Any[]).map((m) => [
				m.userId,
				money(m.balanceDetails?.balance ?? 0),
			]),
		);

		const byUser = new Map<number, Any[]>();
		let otherAccounts = 0;
		for (const r of logs.data as Any[]) {
			if (!current.has(r.userId)) {
				otherAccounts++;
				continue;
			}
			const list = byUser.get(r.userId) ?? [];
			list.push(r);
			byUser.set(r.userId, list);
		}
		for (const list of byUser.values()) {
			list.sort(
				(a, b) =>
					String(a.logDate).localeCompare(String(b.logDate)) ||
					a.paymentLogId - b.paymentLogId,
			);
		}

		const scouts = roster.scouts.map((s: Any) => {
			const rows = byUser.get(s.sbUserId) ?? [];
			const t = totals(rows);
			const rep = reported.get(s.sbUserId) ?? 0;
			return {
				s,
				rows,
				t,
				scout: nameOf(s),
				reported: rep,
				difference: money(t.ledgerBalance - rep),
			};
		});

		const view = args.view ?? (args.name ? "ledger" : "check");
		const note = "Negative means the scout owes the troop.";

		if (view === "ledger") {
			if (!args.name)
				return { data: { error: "view=ledger needs a scout's name." } };
			const hit = findPeople(
				scouts.map((x: Any) => ({
					...x.s,
					personFullName: x.s.personFullName,
					_x: x,
				})),
				args.name,
			);
			if (!hit.length)
				return {
					data: { error: `No scout with an account matches "${args.name}".` },
				};
			return {
				data: {
					note,
					scouts: hit.map((h: Any) => {
						const x = h._x;
						let running = 0;
						const listed: Any[] = [];
						for (const r of x.rows) {
							if (counts(r)) running = money(running + (r.amount ?? 0));
							if (r.deleted && !args.includeDeleted) continue;
							if (args.since && String(r.logDate).slice(0, 10) < args.since)
								continue;
							listed.push(line(r, counts(r) ? running : undefined));
						}
						return {
							scout: x.scout,
							reportedBalance: x.reported,
							...x.t,
							differenceFromReported: x.difference,
							entries: listed,
						};
					}),
				},
			};
		}

		if (view === "summary") {
			const l = [...scouts].sort((a, b) => a.reported - b.reported);
			return {
				data: {
					note,
					count: l.length,
					scouts: l.map((x) => ({
						scout: x.scout,
						reportedBalance: x.reported,
						charges: x.t.charges,
						payments: money(x.t.payments + x.t.onlinePayments),
						credits: x.t.credits,
						unfinishedOnlineAmount:
							x.t.unfinishedOnlinePayments > 0
								? x.t.unfinishedOnlineAmount
								: undefined,
						ledgerBalance: x.t.ledgerBalance,
						entries: x.t.entries,
					})),
				},
			};
		}

		if (view === "owing") {
			const l = scouts
				.filter((x) => x.reported < 0)
				.sort((a, b) => a.reported - b.reported);
			return {
				data: {
					note,
					count: l.length,
					totalOwed: money(l.reduce((a, x) => a + x.reported, 0)),
					scouts: l.map((x) => {
						const live = x.rows.filter(counts);
						const charges = ofType(live, "Charge")
							.sort((a: Any, b: Any) => a.amount - b.amount)
							.slice(0, 5)
							.map((r: Any) => line(r));
						const paid = [
							...ofType(live, "Payment"),
							...ofType(live, "Online"),
							...ofType(live, "Credit"),
						].sort((a: Any, b: Any) =>
							String(b.logDate).localeCompare(String(a.logDate)),
						);
						return {
							scout: x.scout,
							reportedBalance: x.reported,
							charges: x.t.charges,
							payments: money(x.t.payments + x.t.onlinePayments),
							credits: x.t.credits,
							unfinishedOnlineAmount:
								x.t.unfinishedOnlinePayments > 0
									? x.t.unfinishedOnlineAmount
									: undefined,
							largestCharges: charges,
							latestPaymentOrCredit: paid[0] ? line(paid[0]) : null,
						};
					}),
				},
			};
		}

		// view=check
		const mismatches = scouts
			.filter((x) => Math.abs(x.difference) > 0.005)
			.map((x) => ({
				scout: x.scout,
				reportedBalance: x.reported,
				ledgerBalance: x.t.ledgerBalance,
				difference: x.difference,
				// Shows whether the reported balance counts entries marked deleted
				matchesWhenDeletedCounted:
					Math.abs(x.t.ledgerBalanceWithDeleted - x.reported) <= 0.005,
			}));

		const duplicates: Any[] = [];
		const deleted: Any[] = [];
		for (const x of scouts) {
			const seen = new Map<string, Any[]>();
			for (const r of x.rows) {
				if (r.deleted) {
					deleted.push({ scout: x.scout, ...line(r) });
					continue;
				}
				if (r.paymentType !== "Charge") continue;
				const key = [
					r.logDate,
					r.amount,
					norm(clean(r.description)),
					r.calendarEventId ?? "",
				].join("|");
				seen.set(key, [...(seen.get(key) ?? []), r]);
			}
			for (const group of seen.values()) {
				if (group.length > 1) {
					duplicates.push({
						scout: x.scout,
						copies: group.length,
						entries: group.map((r: Any) => line(r)),
					});
				}
			}
		}

		const unfinished: Any[] = [];
		for (const x of scouts)
			for (const r of x.rows)
				if (!r.deleted && unfinishedOnline(r))
					unfinished.push({ scout: x.scout, ...line(r) });

		const typeCounts: Record<string, number> = {};
		for (const x of scouts)
			for (const r of x.rows)
				typeCounts[r.paymentType] = (typeCounts[r.paymentType] ?? 0) + 1;

		return {
			data: {
				note: "Candidates to look at, not proven errors. Duplicates are charges to one scout with the same date, amount, description and event.",
				scoutsChecked: scouts.length,
				entriesOnOtherAccounts: otherAccounts,
				entryTypes: typeCounts,
				balanceMismatches: mismatches,
				unfinishedOnlinePayments: unfinished,
				possibleDuplicateCharges: duplicates,
				deletedEntries: deleted,
			},
		};
	},
});
