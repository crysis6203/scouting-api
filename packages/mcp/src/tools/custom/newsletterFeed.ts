import { z } from "zod";
import { defineTool } from "../define.ts";
import {
	type Any,
	day,
	daysBetween,
	nameOf,
	orgGuidOf,
	pool,
	retry,
	troopYouth,
} from "./troopCommon.ts";

const TZ = "America/Chicago";
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Scoutbook event times are UTC; the troop reads them in Central time
function central(v: unknown) {
	const d = new Date(String(v).endsWith("Z") ? String(v) : `${String(v)}Z`);
	const parts = (o: Intl.DateTimeFormatOptions) =>
		new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...o }).format(d);
	const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
	return {
		ymd,
		date: parts({ weekday: "short", month: "short", day: "numeric" }),
		time: parts({ hour: "numeric", minute: "2-digit" }),
	};
}

// Order for the leadership section; anything else follows alphabetically
const POSITION_ORDER = [
	"senior patrol leader",
	"assistant senior patrol leader",
	"patrol leader",
	"assistant patrol leader",
	"troop guide",
	"quartermaster",
	"scribe",
	"historian",
	"librarian",
	"chaplain aide",
	"den chief",
	"instructor",
	"leave no trace trainer",
	"outdoor ethics guide",
	"order of the arrow troop representative",
	"junior assistant scoutmaster",
];
const orderOf = (p: string) => {
	const i = POSITION_ORDER.indexOf(p.toLowerCase());
	return i < 0 ? 999 : i;
};

export const newsletterFeed = defineTool({
	name: "newsletterFeed",
	title: "Weekly newsletter (ITCs) data",
	description:
		"Short data feed for the weekly ITCs troop newsletter: upcoming troop events (times in Central), RSVP lists for events that have RSVPs turned on (scouts who said yes, alphabetical, no adults), and current scout leadership positions. Optional: a small birthdays line (placed just before leadership) with includeBirthdays. Events within `weeks` weeks (default 4). Weekly troop meetings are flagged isMeeting so they can be left out. Events whose Scoutbook Notes start with 'Newsletter: <title>' come back with newsletter/newsletterDetails (extra lines in the notes are card details); 'Newsletter skip' sets newsletterSkip.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		weeks: z.int().optional().describe("Look-ahead in weeks. Defaults to 4."),
		includeBirthdays: z
			.boolean()
			.optional()
			.describe("Add a short birthdays line for the next 14 days. Defaults to false."),
		includeLeadership: z
			.boolean()
			.optional()
			.describe("Add current scout positions. Defaults to true. Takes a few extra seconds."),
		scoutbookUserId: z.number().optional().describe("Defaults to env SCOUTING_USER_ID."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const userId = args.scoutbookUserId ?? Number(process.env["SCOUTING_USER_ID"]);
		if (!userId) {
			return { data: { error: "Set SCOUTING_USER_ID in the server env, or pass scoutbookUserId." } };
		}
		const from = iso(new Date());
		const to = iso(new Date(Date.now() + (args.weeks ?? 4) * 7 * 864e5));

		const cals = await api.advancement.listUserCalendars({ userId });
		if (cals.error) return cals;
		const unitIds = [
			...new Set<number>(cals.data.map((c: Any) => c.unitId).filter(Boolean)),
		];
		const events = new Map<number, Any>();
		for (const unitId of unitIds) {
			const res = await retry(() =>
				api.advancement.listEvents({ fromDate: from, toDate: to, unitId, showDLEvents: true }),
			);
			if (res.error) {
				if (res.response?.status === 404 || res.error?.errorCode === "C404") continue;
				return res;
			}
			for (const e of res.data) events.set(e.id, e);
		}
		const troopEvents = [...events.values()]
			.filter((e) => (e.units ?? []).some((u: Any) => /troop/i.test(u.unitFullName ?? "")))
			.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));

		const todayCentral = central(new Date().toISOString()).ymd;
		const eventsOut = troopEvents.map((e) => {
			const s = central(e.startDate);
			const en = e.endDate ? central(e.endDate) : null;
			const multiDay = en && en.ymd !== s.ymd;
			// Chris flags events for the newsletter in the Scoutbook event Notes field:
			// first line "Newsletter: Card title", following lines are card details.
			// "Newsletter skip" leaves the event out.
			const lines = String(e.notes ?? "")
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			const tag = lines.findIndex((l) => /^newsletter\b/i.test(l));
			const skip = tag >= 0 && /^newsletter\s+skip\b/i.test(lines[tag] as string);
			const flagged =
				tag >= 0 && !skip
					? {
							newsletter: (lines[tag] as string).replace(/^newsletter\s*:?\s*/i, "").trim() || String(e.name),
							newsletterDetails: lines.slice(tag + 1),
						}
					: {};
			return {
				title: e.name,
				date: multiDay ? `${s.date} – ${en.date}` : `${s.date}, ${s.time}`,
				startYmd: s.ymd,
				details: e.location ? [e.location] : [],
				isMeeting: /troop meeting|weekly meeting|no meeting/i.test(String(e.name)),
				...flagged,
				...(skip ? { newsletterSkip: true } : {}),
				rsvpEnabled: Boolean(e.rsvp),
			};
		});

		const rsvps = troopEvents
			.filter((e) => !/troop meeting|weekly meeting|no meeting/i.test(String(e.name)))
			.map((e) => {
				const s = central(e.startDate);
				const base = { title: e.name, when: `${s.date}`, startYmd: s.ymd };
				if (!e.rsvp) {
					return { ...base, names: [], pending: true, pending_text: "not turned on in Scoutbook for this event" };
				}
				const invited: Any[] = e.invitedUsers ?? [];
				const yes = invited
					.filter((u) => u.rsvpCode === "Y" && !u.isAdult)
					.map((u) => nameOf(u))
					.sort((a, b) => a.localeCompare(b));
				const maybes = invited.filter((u) => u.rsvpCode === "M" && !u.isAdult).length;
				return { ...base, names: yes, yesCount: yes.length, ...(maybes ? { maybeCount: maybes } : {}) };
			});

		const out: Any = {
			rsvp_asof: new Date().toLocaleDateString("en-US", {
				timeZone: TZ,
				month: "long",
				day: "numeric",
				year: "numeric",
			}),
			today: todayCentral,
			events: eventsOut,
			rsvps,
			note: "Compare names against the troop's own list when in doubt: no-response counts as no. Weekly meetings are in events with isMeeting=true and have no RSVP section.",
		};

		const roster = await troopYouth(api, orgGuidOf(args.organizationGuid), true);
		if ("error" in roster) return roster.error;

		if (args.includeBirthdays) {
			const today = new Date(`${iso(new Date())}T00:00:00Z`);
			const rows: { name: string; date: string; inDays: number }[] = [];
			for (const s of roster.scouts) {
				const dob = s.registrarInfo?.dateOfBirth;
				if (!dob) continue;
				const d = new Date(`${String(dob).slice(0, 10)}T00:00:00Z`);
				let next = new Date(Date.UTC(today.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
				if (next < today) next = new Date(Date.UTC(today.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
				const inDays = daysBetween(today, next);
				if (inDays <= 14) {
					rows.push({
						name: nameOf(s),
						date: next.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
						inDays,
					});
				}
			}
			rows.sort((a, b) => a.inDays - b.inDays);
			out.birthdays = rows.map((r) => `${r.name} (${r.date})`);
		}

		if (args.includeLeadership ?? true) {
			const failures: string[] = [];
			const unapproved: string[] = [];
			const rows = await pool(roster.scouts, 4, async (s: Any) => {
				const h = await retry(() =>
					api.advancement.listYouthLeadershipPositionHistory({ userId: s.sbUserId }),
				);
				if (h.error) {
					failures.push(nameOf(s));
					return [];
				}
				return (h.data as Any[])
					.filter((p) => !p.endDate && !day(p.startDate)?.startsWith("9999"))
					.map((p) => {
						if (p.approved === false) unapproved.push(`${nameOf(s)} (${p.position})`);
						const patrol = /patrol leader/i.test(p.position) && p.patrol ? ` (${p.patrol})` : "";
						return { position: String(p.position), name: `${nameOf(s)}${patrol}` };
					});
			});
			const by = new Map<string, string[]>();
			for (const r of rows.flat()) {
				by.set(r.position, [...(by.get(r.position) ?? []), r.name]);
			}
			out.leadership = [...by.entries()]
				.sort((a, b) => orderOf(a[0]) - orderOf(b[0]) || a[0].localeCompare(b[0]))
				.map(([position, names]) => [position, [...new Set(names)].sort((a, b) => a.localeCompare(b))]);
			const doubled = (out.leadership as Any[])
				.filter(([p, n]) => /^(senior patrol leader|quartermaster|scribe|historian|troop guide)$/i.test(p) && p !== "Scribe" && n.length > 1)
				.map(([p, n]) => `${p}: ${n.join(" and ")}`);
			if (doubled.length) out.leadershipCheck = `More than one holder; an old term may need an end date in Scoutbook: ${doubled.join("; ")}`;
			if (unapproved.length) out.leadershipNotApproved = unapproved;
			if (failures.length) out.leadershipFailures = failures;
		}

		return { data: out };
	},
});
