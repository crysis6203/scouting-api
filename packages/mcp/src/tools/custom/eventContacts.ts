import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../define.ts";

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the spec's schemas
type Any = any;

const DEFAULT_ORG_GUID = "fd33d07b-86d3-4f30-9743-004866f9fc59";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const nameOf = (u: Any) =>
	`${u.nickName || u.firstName} ${u.lastName}`.replace(/\s+/g, " ").trim();

// Scoutbook permission roles that say nothing about a leader's job
const PERMISSION_ROLE =
	/editor|approver|awarder|remover|creator|mbc list|key 3 delegate/i;
const RESERVE = /scouter reserve/i;

export const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

type Contact = { email: string | null; phone: string | null };

// Leaders with no scout in the troop have no email in Scoutbook's rosters, so
// they come from a small local file: [{ "name": "Pat Example", "email": "...", "phone": "..." }].
// Set SCOUTING_LEADER_CONTACTS to use another path.
// Addresses Scoutbook fills in when a parent has none; mail to them goes nowhere
const PLACEHOLDER = /^(changeyouremail@scoutbook\.com|multipleacct@scouting\.org)$/i;

export function leaderContacts(): { byName: Map<string, Contact>; path: string; note?: string } {
	const path =
		process.env["SCOUTING_LEADER_CONTACTS"] ??
		join(homedir(), ".scouting-mcp", "leader-contacts.json");
	const byName = new Map<string, Contact>();
	try {
		const rows = JSON.parse(readFileSync(path, "utf8")) as Any[];
		for (const r of rows) {
			byName.set(norm(r.name), { email: r.email ?? null, phone: r.phone ?? null });
		}
		return { byName, path };
	} catch {
		return { byName, path, note: "No leader contact file found at this path" };
	}
}

export const eventContacts = defineTool({
	name: "eventContacts",
	title: "Event attendees with their parents' contact details",
	description:
		"Finds troop calendar events by name and lists who is attending (by RSVP) with contact details. For each scout it gives his parents' names, emails and phones; for each adult who is a parent of a troop scout it gives their own email. Also returns one de-duplicated email list. Use this for questions like 'email everyone coming to the December Lock-In and their parents'. Defaults to events in the next 180 days.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		search: z.string().describe("Part of the event name, e.g. 'Lock-In'"),
		fromDate: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
		toDate: z
			.string()
			.optional()
			.describe("YYYY-MM-DD. Defaults to 180 days after fromDate."),
		who: z
			.enum(["yes", "maybe", "no", "attended", "all"])
			.optional()
			.describe("Which invitees to include. Defaults to yes (RSVP'd yes)."),
		scoutbookUserId: z
			.number()
			.optional()
			.describe("Your own Scoutbook user ID. Defaults to env SCOUTING_USER_ID."),
		organizationGuid: z
			.string()
			.optional()
			.describe("Unit GUID. Defaults to Troop 0911."),
		includeReserve: z
			.boolean()
			.optional()
			.describe(
				"Also list Scouter Reserve and College Scouter Reserve adults in the leaders list. Defaults to false.",
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
						"Set SCOUTING_USER_ID in the server env, or pass scoutbookUserId.",
				},
			};
		}
		const orgGuid =
			args.organizationGuid ?? process.env["SCOUTING_ORG_GUID"] ?? DEFAULT_ORG_GUID;
		const from = args.fromDate ?? iso(new Date());
		const to =
			args.toDate ??
			iso(new Date(new Date(`${from}T00:00:00Z`).getTime() + 180 * 864e5));
		const who = args.who ?? "yes";

		const cals = await api.advancement.listUserCalendars({ userId });
		if (cals.error) return cals;
		const unitIds = [
			...new Set<number>(cals.data.map((c: Any) => c.unitId).filter(Boolean)),
		];

		const events = new Map<number, Any>();
		for (const unitId of unitIds) {
			const res = await api.advancement.listEvents({
				fromDate: from,
				toDate: to,
				unitId,
				showDLEvents: true,
			});
			if (res.error) {
				if (res.response?.status === 404 || res.error?.errorCode === "C404") {
					continue;
				}
				return res;
			}
			for (const e of res.data) events.set(e.id, e);
		}

		const q = args.search.toLowerCase().trim();
		const matched = [...events.values()]
			.filter((e) => String(e.name).toLowerCase().includes(q))
			.filter((e) =>
				(e.units ?? []).some((u: Any) => /troop/i.test(u.unitFullName ?? "")),
			)
			.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
			.slice(0, 5);
		if (matched.length === 0) {
			return {
				data: { from, to, error: `No troop events matching "${args.search}"` },
			};
		}

		const parentsRes = await api.organizations.listUnitParents({
			organizationGuid: orgGuid,
		});
		if (parentsRes.error) return parentsRes;

		// youth userId -> parents; parent userId -> their own contact record
		const parentsOf = new Map<number, Any[]>();
		const parentRecord = new Map<number, Any>();
		for (const link of parentsRes.data as Any[]) {
			if (link.parentUserId == null) continue;
			const info = link.parentInformation;
			const rec = {
				name: info.personFullName,
				email: info.email || null,
				mobilePhone: info.mobilePhone || null,
				homePhone: info.homePhone || null,
			};
			parentsOf.set(link.youthUserId, [
				...(parentsOf.get(link.youthUserId) ?? []),
				rec,
			]);
			parentRecord.set(link.parentUserId, rec);
		}

		const adultsRes = await api.organizations.listOrganizationAdults({
			organizationGuid: orgGuid,
			includeExpired: false,
		});
		if (adultsRes.error) return adultsRes;
		const local = leaderContacts();

		// One entry per adult, with every position they hold
		const adults = new Map<string, Any>();
		for (const a of adultsRes.data.members as Any[]) {
			const cur = adults.get(a.personGuid) ?? { a, positions: [] as string[] };
			if (a.position && !cur.positions.includes(a.position)) {
				cur.positions.push(a.position);
			}
			adults.set(a.personGuid, cur);
		}
		const parentByGuid = new Map<string, Any>();
		for (const link of parentsRes.data as Any[]) {
			if (link.parentInformation?.personGuid) {
				parentByGuid.set(
					String(link.parentInformation.personGuid).toLowerCase(),
					link.parentInformation,
				);
			}
		}
		const contactFor = (first: string, last: string, nick: string | null, guid?: string) => {
			const p = guid ? parentByGuid.get(guid.toLowerCase()) : undefined;
			if (p?.email) return { email: p.email as string, phone: (p.mobilePhone ?? p.homePhone ?? null) as string | null, source: "scoutbook parent record" };
			const l =
				local.byName.get(norm(`${first} ${last}`)) ??
				(nick ? local.byName.get(norm(`${nick} ${last}`)) : undefined);
			if (l?.email) return { email: l.email, phone: l.phone, source: "local leader file" };
			return { email: null, phone: l?.phone ?? (p?.mobilePhone ?? p?.homePhone ?? null), source: null };
		};

		const pick = (u: Any) => {
			if (who === "all") return true;
			if (who === "attended") return Boolean(u.attended);
			const code = { yes: "Y", maybe: "M", no: "N" }[who];
			return (u.rsvpCode ?? "") === code;
		};

		const out = matched.map((e) => {
			const people: Any[] = (e.invitedUsers ?? []).filter(pick);
			const emails = new Set<string>();
			const missing: string[] = [];
			const attendees = people.map((u) => {
				const base = {
					name: nameOf(u),
					role: u.isAdult ? "adult" : "scout",
					rsvp: u.rsvpCode || "no response",
				};
				if (u.isAdult) {
					const rec = parentRecord.get(u.userId);
					const c = rec?.email
						? { email: rec.email as string, phone: rec.mobilePhone as string | null }
						: contactFor(u.firstName, u.lastName, u.nickName);
					if (c.email) emails.add(c.email);
					else missing.push(`${base.name} (adult, no email available)`);
					return { ...base, email: c.email, mobilePhone: c.phone };
				}
				const parents = parentsOf.get(u.userId) ?? [];
				for (const p of parents) if (p.email) emails.add(p.email);
				if (!parents.some((p) => p.email)) {
					missing.push(`${base.name} (no parent email on file)`);
				}
				return { ...base, parents };
			});
			// Every registered adult leader, with their response to this event
			const invited: Any[] = e.invitedUsers ?? [];
			const status = (code: string, attended: boolean) =>
				attended ? "attended" : { Y: "yes", N: "no", M: "maybe" }[code] ?? "no response";
			const leaders = [...adults.values()]
				.filter(
					({ positions }) =>
						args.includeReserve || !positions.every((p: string) => RESERVE.test(p)),
				)
				.map(({ a, positions: all }) => {
				const positions = all.filter((p: string) => !PERMISSION_ROLE.test(p));
				const inv = invited.find(
					(u) =>
						norm(u.lastName) === norm(a.lastName) &&
						(norm(u.firstName) === norm(a.firstName) ||
							(a.nickName && norm(u.firstName) === norm(a.nickName)) ||
							(u.nickName && norm(u.nickName) === norm(a.firstName))),
				);
				const c = contactFor(a.firstName, a.lastName, a.nickName, a.personGuid);
				return {
					name: a.personFullName ?? `${a.firstName} ${a.lastName}`,
					positions,
					status: inv ? status(inv.rsvpCode ?? "", Boolean(inv.attended)) : "not invited",
					email: c.email,
					phone: c.phone,
					emailSource: c.source,
				};
			});
			const order = ["yes", "attended", "maybe", "no response", "not invited", "no"];
			leaders.sort(
				(x, y) => order.indexOf(x.status) - order.indexOf(y.status) || x.name.localeCompare(y.name),
			);
			const counts: Record<string, number> = {};
			for (const l of leaders) counts[l.status] = (counts[l.status] ?? 0) + 1;
			return {
				id: e.id,
				name: e.name,
				start: String(e.startDate).slice(0, 16).replace("T", " "),
				count: attendees.length,
				attendees,
				emailList: [...emails].filter((e) => !PLACEHOLDER.test(e)).sort(),
				placeholderEmails: [...emails].filter((e) => PLACEHOLDER.test(e)).sort(),
				missing,
				leaderStatusCounts: counts,
				leaders,
				leadersWithoutEmail: leaders.filter((l) => !l.email).map((l) => l.name),
			};
		});

		return {
			data: {
				from,
				to,
				who,
				leaderContactFile: local.note ? `${local.path} (${local.note})` : local.path,
				events: out,
			},
		};
	},
});
