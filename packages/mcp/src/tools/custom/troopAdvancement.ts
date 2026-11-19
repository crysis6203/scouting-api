import { z } from "zod";
import { defineTool } from "../define.ts";
import {
	type Any,
	RANKS,
	clean,
	day,
	daysBetween,
	findPeople,
	isAwarded,
	nameOf,
	norm,
	orgGuidOf,
	pool,
	rankDate,
	retry,
	scoutsBsaRanks,
	troopYouth,
} from "./troopCommon.ts";

const label = (r: Any) => {
	const a = clean(r.listNumber);
	const b = clean(r.requirementNumber);
	return (a || b).replace(/\.$/, "");
};
const isDone = (r: Any) => Boolean(r.completed);

// Summary of one scout's Scouts BSA ranks
function rankSummary(ranksData: Any) {
	const ranks = scoutsBsaRanks(ranksData);
	const awarded = ranks.filter(isAwarded);
	const current = awarded[awarded.length - 1];
	const open = ranks.filter((r) => !isAwarded(r));
	const awaiting = open.filter((r) => Number(r.percentCompleted) >= 1);
	const next = open.find((r) => Number(r.percentCompleted) < 1) ?? open[0];
	return { ranks, current, awaiting, next };
}

function currentPosition(history: Any[]) {
	const now = new Date();
	const open = history.filter((h) => !h.endDate);
	return open.map((h) => ({
		position: h.position,
		patrol: h.patrol ?? undefined,
		since: day(h.startDate),
		days: h.startDate
			? daysBetween(new Date(String(h.startDate).slice(0, 10)), now)
			: (h.numberOfDaysInPosition ?? null),
		approved: h.approved,
	}));
}

export const troopAdvancement = defineTool({
	name: "troopAdvancement",
	title: "Troop-wide advancement reports",
	description: [
		"Advancement questions across the whole troop, or one scout when `name` is given.",
		"view=overview: current rank, when each rank was earned, ranks approved but awaiting award, next-rank progress, and current leadership position with how long it has been held. With `name`, also gives every rank date and the full position history. Use for 'when did Nick earn Star?' and 'how long has Coleton been SPL?'.",
		"view=requirement: scouts who have NOT completed a requirement. Give `requirement` as a number (e.g. '7d') or words (e.g. 'swim'). `rank` defaults to each scout's next unearned rank. Use for 'who still needs First Class 7d?'.",
		"view=swim: swim status from the rank requirements. Beginner swim test is Second Class 5b and the BSA swim test is First Class 6a. Use for 'who passed the BSA swim test?' and 'who is a beginner swimmer?'.",
		"view=boardReady: scouts whose only unfinished items for their next rank are the Scoutmaster conference and/or board of review.",
		"view=leadershipDue: scouts whose position-of-responsibility requirement for Star, Life or Eagle is not yet marked complete, although their leadership history shows they have served long enough while holding the previous rank. Use for 'who has served the months but hasn\'t been signed off?'.",
		"view=eagle: merit badge counts (earned, in progress, Eagle-required flagged) for Star, Life and Eagle-bound scouts. The Eagle-required count counts alternatives (e.g. Hiking and Cycling) separately, so treat it as an upper bound.",
		"Makes many API calls, so the troop-wide views can take 30-60 seconds.",
	].join(" "),
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		view: z
			.enum(["overview", "requirement", "swim", "boardReady", "eagle", "leadershipDue"])
			.optional()
			.describe("Defaults to overview."),
		name: z.string().optional().describe("Limit to one scout, e.g. 'Coleton'."),
		rank: z
			.string()
			.optional()
			.describe("For view=requirement: Tenderfoot, Second Class, First Class, Star, Life or Eagle."),
		requirement: z
			.string()
			.optional()
			.describe("For view=requirement: requirement number like '7d' or words from its text."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: (scouting, args) => timed(scouting, args),
});

// Adds how long the run took, to see how close the troop-wide views get to the
// bridge's time limit
async function timed(scouting: Any, args: Any) {
	const t0 = Date.now();
	const out = await run(scouting, args);
	if (out?.data && typeof out.data === "object" && !("error" in out.data)) {
		out.data.elapsedSeconds = Math.round((Date.now() - t0) / 100) / 10;
	}
	return out;
}

async function run(scouting: Any, args: Any): Promise<Any> {
	{
		const api = scouting.api as Any;
		const view = args.view ?? "overview";
		const roster = await troopYouth(api, orgGuidOf(args.organizationGuid));
		if ("error" in roster) return roster.error;
		let scouts = roster.scouts;
		if (args.name) {
			scouts = findPeople(scouts, args.name);
			if (scouts.length === 0) {
				return { data: { error: `No youth on the roster matches "${args.name}".` } };
			}
			if (scouts.length > 1 && view === "overview") {
				return {
					data: {
						error: `More than one match for "${args.name}". Use a fuller name.`,
						matches: scouts.map((s: Any) => s.personFullName),
					},
				};
			}
		}

		const fetchReqs = (userId: number, rankId: number) =>
			retry(() => api.advancement.getYouthRankRequirements({ userId, rankId }));
		const noRecord: string[] = [];
		const failures: string[] = [];
		const note = (s: Any, what: string) =>
			failures.push(`${nameOf(s)}: ${what}`);

		// ---------------------------------------------------------- overview
		if (view === "overview") {
			const one = args.name ? scouts[0] : undefined;
			const rows = await pool(scouts, 4, async (s: Any) => {
				const [r, h] = await Promise.all([
					retry(() => api.advancement.listYouthRanks({ userId: s.sbUserId })),
					retry(() => api.advancement.listYouthLeadershipPositionHistory({ userId: s.sbUserId })),
				]);
				if (r.error) {
					note(s, "rank lookup failed");
					return null;
				}
				const sum = rankSummary(r.data);
				const lastDate = sum.current ? rankDate(sum.current) : null;
				const row: Any = {
					scout: nameOf(s),
					rank: sum.current?.name ?? "No rank yet",
					earned: lastDate,
					daysSinceLastRank: lastDate
						? daysBetween(new Date(lastDate), new Date())
						: null,
					awaitingAward: sum.awaiting.map((x: Any) => x.name),
					nextRank: sum.next?.name ?? null,
					nextRankPercent: sum.next
						? Math.round(Number(sum.next.percentCompleted ?? 0) * 100)
						: null,
					positions: h.error ? undefined : currentPosition(h.data as Any[]),
				};
				if (one) {
					row.rankDates = Object.fromEntries(
						sum.ranks
							.filter(isAwarded)
							.map((x: Any) => [x.name, rankDate(x)]),
					);
					row.positionHistory = h.error
						? undefined
						: (h.data as Any[]).map((x) => ({
								position: x.position,
								patrol: x.patrol ?? undefined,
								start: day(x.startDate),
								end: day(x.endDate),
								days: x.numberOfDaysInPosition,
								approved: x.approved,
							}));
				}
				return row;
			});
			return {
				data: {
					scouts: rows.filter(Boolean),
					failures: failures.length ? failures : undefined,
				},
			};
		}

		// ---------------------------------------------------------- swim
		if (view === "swim") {
			const rows = await pool(scouts, 4, async (s: Any) => {
				const [sc, fc] = await Promise.all([
					fetchReqs(s.sbUserId, 3),
					fetchReqs(s.sbUserId, 4),
				]);
				const find = (res: Any, re: RegExp) =>
					res.error
						? undefined
						: (res.data.requirements ?? []).find((r: Any) =>
								re.test(`${r.short ?? ""} ${r.name ?? ""}`),
							);
				const beginner = find(sc, /beginner swim/i);
				const bsa = find(fc, /bsa swim test/i);
				const missing = (x: Any) => x.error && x.response?.status === 404;
				if ((sc.error && !missing(sc)) || (fc.error && !missing(fc))) {
					note(s, "swim requirement lookup failed");
				}
				const bsaDone = bsa ? isDone(bsa) : false;
				const begDone = beginner ? isDone(beginner) : false;
				const fcAwarded = !fc.error && Boolean(fc.data.awarded);
				const scAwarded = !sc.error && Boolean(sc.data.awarded);
				let status = "Not recorded";
				if (bsaDone) status = "BSA swimmer";
				else if (fcAwarded) status = "BSA swimmer (inferred from First Class)";
				else if (begDone) status = "Beginner";
				else if (scAwarded) status = "Beginner (inferred from Second Class)";
				return {
					scout: nameOf(s),
					status,
					beginnerTestDate: beginner ? day(beginner.dateCompleted) : null,
					bsaTestDate: bsa ? day(bsa.dateCompleted) : null,
				};
			});
			return {
				data: {
					bsaSwimmers: rows.filter((r) => r.status.startsWith("BSA swimmer")),
					beginners: rows.filter((r) => r.status.startsWith("Beginner")),
					notRecorded: rows.filter((r) => r.status === "Not recorded").map((r) => r.scout),
					failures: failures.length ? failures : undefined,
					note: "Taken from the Second Class 5b and First Class 6a requirement records, not a Scoutbook swim classification. 'Inferred' means the rank is awarded but Scoutbook has no entry for the test itself. Scouts who have not started those ranks show as Not recorded.",
				},
			};
		}

		// ---------------------------------------------------------- eagle
		if (view === "eagle") {
			const rows = await pool(scouts, 4, async (s: Any) => {
				const r = await retry(() => api.advancement.listYouthRanks({ userId: s.sbUserId }));
				if (r.error) {
					note(s, "rank lookup failed");
					return null;
				}
				const sum = rankSummary(r.data);
				const level = sum.current?.level ?? 0;
				if (!args.name && level < 5) return null; // Star and up only
				if (sum.current?.name === "Eagle Scout") return null;
				const mb = await retry(() => api.advancement.listYouthMeritBadges({ userId: s.sbUserId }));
				if (mb.error) {
					note(s, "merit badge lookup failed");
					return null;
				}
				const list = mb.data as Any[];
				const earned = list.filter(
					(b) => b.awardedDate || b.status === "Awarded" || b.leaderApprovedDate,
				);
				const done = (b: Any) => earned.includes(b);
				return {
					scout: nameOf(s),
					rank: sum.current?.name ?? null,
					meritBadgesEarned: earned.length,
					neededFor21: Math.max(0, 21 - earned.length),
					eagleRequiredEarnedUpperBound: list.filter(
						(b) => done(b) && b.isEagleRequired,
					).length,
					inProgress: list
						.filter((b) => !done(b))
						.map((b) => ({
							badge: b.name,
							percent: Math.round(Number(b.percentCompleted ?? 0) * 100),
						})),
				};
			});
			const out = rows
				.filter(Boolean)
				.sort((a: Any, b: Any) => b.meritBadgesEarned - a.meritBadgesEarned);
			return {
				data: {
					scouts: out,
					failures: failures.length ? failures : undefined,
					note: "Earned counts badges Scoutbook shows as leader approved or awarded. Eagle-required counts alternatives separately.",
				},
			};
		}

		// ---------------------------------------------------------- leadershipDue
		if (view === "leadershipDue") {
			const WORDS: Record<string, number> = {
				three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, twelve: 12,
			};
			const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
			const earnedOn = (r: Any) =>
				day(r.leaderApprovedDate) ?? day(r.dateEarned) ?? day(r.awardedDate);
			const rows = await pool(scouts, 4, async (s: Any) => {
				const r = await retry(() => api.advancement.listYouthRanks({ userId: s.sbUserId }));
				if (r.error) {
					note(s, "rank lookup failed");
					return null;
				}
				const sum = rankSummary(r.data);
				// Star (5), Life (6) and Eagle (7) have the leadership requirement
				const target = sum.ranks.find((x: Any) => !isAwarded(x) && x.id >= 5);
				if (!target) return null;
				const prev = sum.ranks.find((x: Any) => x.id === target.id - 1);
				const prevDate = prev ? earnedOn(prev) : null;
				if (!prevDate) return null; // previous rank not earned yet
				const [reqRes, hist] = await Promise.all([
					fetchReqs(s.sbUserId, target.id),
					retry(() => api.advancement.listYouthLeadershipPositionHistory({ userId: s.sbUserId })),
				]);
				if (reqRes.error || hist.error) {
					note(s, "requirement or position lookup failed");
					return null;
				}
				const por = (reqRes.data.requirements ?? []).find((q: Any) =>
					/position of responsibility|serve actively/i.test(`${q.short ?? ""} ${clean(q.name)}`),
				);
				if (!por || isDone(por)) return null;
				const text = clean(por.name);
				const m = /(\w+) months/i.exec(text);
				const months = m ? (WORDS[m[1]?.toLowerCase() ?? ""] ?? Number(m[1])) : NaN;
				if (!Number.isFinite(months)) {
					note(s, "could not read the months required");
					return null;
				}
				// Eagle does not count assistant patrol leader or bugler
				const skip = target.id === 7 ? /assistant patrol leader|bugler/i : /bugler/i;
				const spans = (hist.data as Any[])
					.filter((h) => h.startDate && !skip.test(String(h.position)))
					.map((h) => ({
						position: h.position,
						approved: h.approved,
						start: new Date(
							Math.max(
								new Date(`${String(h.startDate).slice(0, 10)}T00:00:00Z`).getTime(),
								new Date(`${prevDate}T00:00:00Z`).getTime(),
							),
						),
						end: h.endDate
							? new Date(`${String(h.endDate).slice(0, 10)}T00:00:00Z`)
							: today,
					}))
					.filter((x) => x.end > x.start)
					.sort((a, b) => a.start.getTime() - b.start.getTime());
				// Merge overlapping spans so two positions at once count once
				let covered = 0;
				let cursor = 0;
				for (const x of spans) {
					const from = Math.max(x.start.getTime(), cursor);
					if (x.end.getTime() > from) {
						covered += x.end.getTime() - from;
						cursor = x.end.getTime();
					}
				}
				const served = covered / 86_400_000 / 30.44;
				if (served < months) return null;
				return {
					scout: nameOf(s),
					workingToward: target.name,
					monthsRequired: months,
					monthsServed: Math.round(served * 10) / 10,
					since: prevDate,
					requirementStatus: por.status || "Not started",
					positions: spans.map((x) => ({
						position: x.position,
						from: x.start.toISOString().slice(0, 10),
						to: x.end >= today ? "present" : x.end.toISOString().slice(0, 10),
						approvedInScoutbook: x.approved,
					})),
				};
			});
			return {
				data: {
					scouts: rows.filter(Boolean),
					failures: failures.length ? failures : undefined,
					note: "Counts time in positions after the scout earned the previous rank, merging overlaps. 'Approved' is Scoutbook's own flag on the position. Check each position is one your rank allows before signing off.",
				},
			};
		}

		// ----------------------------------------- requirement / boardReady
		const wantRank = args.rank ? RANKS[norm(args.rank)] : undefined;
		if (args.rank && !wantRank) {
			return {
				data: {
					error: `Unknown rank "${args.rank}". Use Scout, Tenderfoot, Second Class, First Class, Star, Life or Eagle.`,
				},
			};
		}
		if (view === "requirement" && !args.requirement) {
			return { data: { error: "Give `requirement`, e.g. '7d' or 'swim'." } };
		}
		const q = norm(args.requirement ?? "").replace(/\.$/, "");
		const matches = (r: Any) =>
			label(r).toLowerCase() === q ||
			norm(`${r.short ?? ""} ${clean(r.name)}`).includes(q);

		const rows = await pool(scouts, 4, async (s: Any) => {
			let rankId: number;
			if (wantRank) {
				rankId = wantRank[0];
			} else {
				const r = await retry(() => api.advancement.listYouthRanks({ userId: s.sbUserId }));
				if (r.error) {
					note(s, "rank lookup failed");
					return null;
				}
				const next = rankSummary(r.data).next;
				if (!next) return null; // Eagle already
				rankId = next.id;
			}
			const res = await fetchReqs(s.sbUserId, rankId);
			if (res.error) {
				// 404 means the scout has no record for that rank yet
				if (res.response?.status === 404) noRecord.push(nameOf(s));
				else note(s, `rank ${rankId} lookup failed`);
				return null;
			}
			const d = res.data;
			if (d.awarded) return null;
			const reqs: Any[] = d.requirements ?? [];
			const kids = (id: number) => reqs.filter((r) => r.parentRequirementId === id);
			const open = reqs.filter(
				(r) => !isDone(r) && !r.optional && kids(r.id).length === 0,
			);
			if (view === "boardReady") {
				if (open.length === 0) {
					return { scout: nameOf(s), rank: d.name, state: "Everything approved, awaiting award" };
				}
				const rest = open.filter(
					(r) => !/scoutmaster conference|board of review/i.test(`${r.short ?? ""} ${clean(r.name)}`),
				);
				if (rest.length > 0) return null;
				return {
					scout: nameOf(s),
					rank: d.name,
					stillNeeds: open.map((r) => clean(r.short) || label(r)),
				};
			}
			const target = reqs.find(matches);
			if (!target || isDone(target)) return null;
			return {
				scout: nameOf(s),
				rank: d.name,
				requirement: `${label(target)} ${clean(target.short)}`.trim(),
				status: target.status || "Not started",
			};
		});
		return {
			data: {
				view,
				rank: wantRank?.[1] ?? "each scout's next unearned rank",
				scouts: rows.filter(Boolean),
				noRecordForRank: noRecord.length ? noRecord : undefined,
				failures: failures.length ? failures : undefined,
			},
		};
	}
}
