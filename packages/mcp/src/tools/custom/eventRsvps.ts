import { z } from "zod";
import { defineTool } from "../define.ts";

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the spec's schemas
type Any = any;

const CODES: Record<string, string> = { Y: "yes", N: "no", M: "maybe" };
const day = (v: unknown) =>
	v ? String(v).slice(0, 16).replace("T", " ") : null;
const name = (u: Any) =>
	`${u.nickName || u.firstName} ${u.lastName}`.replace(/\s+/g, " ").trim();
const iso = (d: Date) => d.toISOString().slice(0, 10);

export const eventRsvps = defineTool({
	name: "eventRsvps",
	title: "Upcoming events with RSVP and attendance",
	description:
		"Lists the troop's calendar events in a date range with RSVP counts (yes/no/maybe/no response), who said what, and who attended. Filter with `search` (part of the event name). Defaults to the next 30 days. Use this for questions like 'who's coming to the campout?' or 'what's on the calendar this month?'.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		fromDate: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
		toDate: z
			.string()
			.optional()
			.describe("YYYY-MM-DD. Defaults to 30 days after fromDate."),
		search: z
			.string()
			.optional()
			.describe("Only events whose name contains this text"),
		includeNames: z
			.boolean()
			.optional()
			.describe(
				"List who RSVP'd and attended. Defaults to true when search is set.",
			),
		scoutbookUserId: z
			.number()
			.optional()
			.describe(
				"The signed-in leader's own Scoutbook user ID. Defaults to env SCOUTING_USER_ID.",
			),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const userId =
			args.scoutbookUserId ?? Number(process.env["SCOUTING_USER_ID"]);
		if (!userId) {
			return {
				data: {
					error:
						"Set SCOUTING_USER_ID (your own Scoutbook user ID) in the server env, or pass scoutbookUserId.",
				},
			};
		}
		const from = args.fromDate ?? iso(new Date());
		const to =
			args.toDate ??
			iso(new Date(new Date(`${from}T00:00:00Z`).getTime() + 30 * 864e5));

		const cals = await api.advancement.listUserCalendars({ userId });
		if (cals.error) return cals;
		const unitIds = [
			...new Set<number>(cals.data.map((c: Any) => c.unitId).filter(Boolean)),
		];

		const events = new Map<number, Any>();
		const skipped: number[] = [];
		for (const unitId of unitIds) {
			const res = await api.advancement.listEvents({
				fromDate: from,
				toDate: to,
				unitId,
				showDLEvents: true,
			});
			// Some calendars point at units with no events or no access (404); skip them
			if (res.error) {
				if (res.response?.status === 404 || res.error?.errorCode === "C404") {
					skipped.push(unitId);
					continue;
				}
				return res;
			}
			for (const e of res.data) events.set(e.id, e);
		}

		const q = args.search?.toLowerCase().trim();
		const showNames = args.includeNames ?? Boolean(q);
		const out = [...events.values()]
			.filter((e) => !q || String(e.name).toLowerCase().includes(q))
			// Troop events only; pack events share the same calendar list
			.filter((e) =>
				(e.units ?? []).some((u: Any) => /troop/i.test(u.unitFullName ?? "")),
			)
			.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
			.map((e) => {
				const invited: Any[] = e.invitedUsers ?? [];
				const by = (code: string) =>
					invited.filter((u) => (u.rsvpCode ?? "") === code);
				const attended = invited.filter((u) => u.attended);
				return {
					id: e.id,
					name: e.name,
					start: day(e.startDate),
					end: day(e.endDate),
					location: e.location || null,
					rsvpEnabled: Boolean(e.rsvp),
					invited: invited.length,
					rsvp: e.rsvp
						? {
								yes: by("Y").length,
								no: by("N").length,
								maybe: by("M").length,
								noResponse: invited.filter((u) => !CODES[u.rsvpCode ?? ""])
									.length,
							}
						: undefined,
					attendedCount: attended.length,
					...(showNames && e.rsvp
						? {
								yes: by("Y").map(name),
								no: by("N").map(name),
								maybe: by("M").map(name),
							}
						: {}),
					...(showNames ? { attended: attended.map(name) } : {}),
				};
			});

		return {
			data: {
				from,
				to,
				count: out.length,
				events: out,
				...(skipped.length ? { skippedUnitIds: skipped } : {}),
			},
		};
	},
});
