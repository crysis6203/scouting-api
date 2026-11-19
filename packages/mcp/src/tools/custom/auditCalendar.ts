import { z } from "zod";
import { defineTool } from "../define.ts";
import { operations as apiOperations } from "../generated/api.scouting.org/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: audits raw, unvalidated responses
type Any = any;

const op = (name: string) => {
	const found = apiOperations.find((o) => o.name === name);
	if (!found) throw new Error(`no operation ${name}`);
	return found;
};

const typeOf = (v: unknown) =>
	v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

// "users[3].rsvp" -> "users[].rsvp"
const norm = (path: PropertyKey[]) =>
	path.map((p) => (typeof p === "number" ? "[]" : `.${String(p)}`)).join("").replace(/^\./, "");

type Stat = { count: number; examples: number[] };

// Collects the set of JSON types seen at every field path, recursing through
// objects and arrays
function inventory(v: unknown, path: string, into: Map<string, Map<string, number>>) {
	const t = typeOf(v);
	const m = into.get(path) ?? new Map<string, number>();
	m.set(t, (m.get(t) ?? 0) + 1);
	into.set(path, m);
	if (Array.isArray(v)) {
		if (v.length === 0) {
			const e = into.get(`${path}[]`) ?? new Map<string, number>();
			e.set("(never non-empty)", 0);
			into.set(`${path}[]`, e);
		}
		for (const x of v) inventory(x, `${path}[]`, into);
	} else if (v && typeof v === "object") {
		for (const [k, x] of Object.entries(v)) {
			inventory(x, path ? `${path}.${k}` : k, into);
		}
	}
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
	let i = 0;
	await Promise.all(
		Array.from({ length: size }, async () => {
			while (i < items.length) await fn(items[i++] as T);
		}),
	);
}

export const auditCalendar = defineTool({
	name: "auditCalendar",
	title: "Debug: audit calendar responses against the spec",
	description:
		"Debug only. Crawls listEvents for every half-year, then getEvent and listEventGuests for a varied sample of events (RSVP-enabled ones first), and checks each raw response against the spec's Zod schema (strict, so unlisted fields count). Returns the mismatches grouped by field path with example event IDs, and the JSON types actually seen at every field path.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		unitIds: z.array(z.int()).describe("Unit IDs to crawl, e.g. [6282, 31677]"),
		fromYear: z.int().optional().describe("Defaults to 2022"),
		toYear: z.int().optional().describe("Defaults to 2027"),
		maxEvents: z.int().optional().describe("Cap on getEvent calls. Default 100, picked across event types and years"),
		fieldFilter: z
			.string()
			.optional()
			.describe("Only list type inventory paths containing this text"),
	}),
	call: async (scouting, args) => {
		const issues = new Map<string, Stat>();
		const inv = new Map<string, Map<string, number>>();
		const failures: string[] = [];
		const ids = new Map<number, Any>();

		const check = (opName: string, data: unknown, id: number, root: string) => {
			const out = op(opName).output;
			const r = out?.safeParse(data);
			if (r && !r.success) {
				for (const i of r.error.issues) {
					const key = `${opName}:${norm(i.path)} :: ${i.message}`;
					const s = issues.get(key) ?? { count: 0, examples: [] };
					s.count++;
					if (s.examples.length < 3) s.examples.push(id);
					issues.set(key, s);
				}
			}
			inventory(data, root, inv);
		};

		const from = args.fromYear ?? 2022;
		const to = args.toYear ?? 2027;
		const windows: { unitId: number; f: string; t: string }[] = [];
		for (const unitId of args.unitIds) {
			for (let y = from; y <= to; y++) {
				windows.push({ unitId, f: `${y}-01-01`, t: `${y}-06-30` });
				windows.push({ unitId, f: `${y}-07-01`, t: `${y}-12-31` });
			}
		}

		await pool(windows, 4, async (w) => {
			const res = await scouting.api.advancement.listEvents({
				fromDate: w.f,
				toDate: w.t,
				unitId: w.unitId,
				showDLEvents: true,
			} as Any);
			if (res.error) {
				failures.push(`listEvents ${w.unitId} ${w.f}: ${res.response?.status}`);
				return;
			}
			check("listEvents", res.data, w.unitId, "list");
			for (const e of res.data as Any[]) ids.set(e.id, e);
		});

		// Round-robin across (event type, year) groups so the sample is varied,
		// taking events with RSVPs on and invitees first within each group
		const groups = new Map<string, Any[]>();
		for (const e of ids.values()) {
			const k = `${e.eventType}|${String(e.startDate).slice(0, 4)}`;
			groups.set(k, [...(groups.get(k) ?? []), e]);
		}
		const score = (e: Any) =>
			(e.rsvp ? 2 : 0) + ((e.invitedUsers?.length ?? 0) > 0 ? 1 : 0);
		for (const g of groups.values()) g.sort((a, b) => score(b) - score(a));
		const max = args.maxEvents ?? 100;
		const eventIds: number[] = [];
		for (let round = 0; eventIds.length < max; round++) {
			let added = false;
			for (const g of groups.values()) {
				const e = g[round];
				if (e && eventIds.length < max) {
					eventIds.push(e.id);
					added = true;
				}
			}
			if (!added) break;
		}
		await pool(eventIds, 6, async (eventId) => {
			const d = await scouting.api.advancement.getEvent({ eventId } as Any);
			if (d.error) {
				failures.push(
					`getEvent ${eventId}: ${d.response?.status} ${JSON.stringify(d.error).slice(0, 120)} :: ${JSON.stringify(
						(({ name, eventType, startDate, userId, temp, rsvp, units }: Any) => ({
							name,
							eventType,
							startDate,
							creator: userId,
							temp,
							rsvp,
							units: units?.map((u: Any) => `${u.unitId}:${u.unitFullName}`),
						}))(ids.get(eventId) ?? {}),
					)}`,
				);
			} else check("getEvent", d.data, eventId, "detail");
			const g = await scouting.api.advancement.listEventGuests({ eventId } as Any);
			if (g.error) {
				failures.push(`listEventGuests ${eventId}: ${g.response?.status}`);
			} else check("listEventGuests", g.data, eventId, "guests");
		});

		const f = args.fieldFilter;
		return {
			data: {
				windows: windows.length,
				eventsFound: ids.size,
				eventsFetched: eventIds.length,
				failures,
				mismatches: Object.fromEntries(
					[...issues].sort((a, b) => b[1].count - a[1].count),
				),
				types: Object.fromEntries(
					[...inv]
						.filter(([p]) => !f || p.includes(f))
						.map(([p, m]) => [p, Object.fromEntries(m)]),
				),
			},
		};
	},
});
