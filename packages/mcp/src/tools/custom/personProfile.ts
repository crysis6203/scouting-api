import { z } from "zod";
import { defineTool } from "../define.ts";
import {
	type Any,
	clean,
	daysBetween,
	findPeople,
	nameOf,
	orgGuidOf,
	personProfile,
	pool,
	troopYouth,
} from "./troopCommon.ts";

const dayOf = (v: unknown) => {
	const t = String(v ?? "").slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

const phones = (p: Any) =>
	(p.phones ?? []).map((x: Any) => ({ type: clean(x.type), number: x.fullPhoneNumber, primary: x.isPrimary === "True" }));
const emails = (p: Any) =>
	(p.emails ?? []).map((x: Any) => ({ type: clean(x.type), email: x.email, primary: x.isPrimary === "True" }));

// Annual health record parts A/B and C are good for 12 months from their date
const health = (x: Any, today: Date) => {
	const status = (d: string | null) =>
		!d ? "No date recorded" : daysBetween(new Date(d), today) > 365 ? `Dated ${d}, over a year ago` : `Dated ${d}, within a year`;
	const ab = dayOf(x?.annualHealthRecordABDate);
	const c = dayOf(x?.annualHealthRecordCDate);
	return { partsAB: status(ab), partC: status(c), partsABDate: ab, partCDate: c };
};

export const personProfileTool = defineTool({
	name: "personProfile",
	title: "A person's own profile: email, swim classification, health forms",
	description:
		"Reads each scout's own Scoutbook profile. view=profile: one person's own emails and phones, Scoutbook swim classification, and health form dates (give `name`). view=health: every scout's annual health record Parts A/B and C dates, flagging ones over a year old or missing. view=swim: every scout's Scoutbook swim classification and test date. view=emails: every scout's own email address. Use for 'what is Keaton's email?', 'who has an expired health form?', 'who is a beginner swimmer?'. Health form dates are what a leader typed into Scoutbook, so treat them as a record, not proof of a signed form.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		view: z.enum(["profile", "health", "swim", "emails"]).optional().describe("Defaults to profile."),
		name: z.string().optional().describe("Scout or adult name. Required for view=profile; limits the other views to one scout."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const view = args.view ?? "profile";
		const orgGuid = orgGuidOf(args.organizationGuid);
		const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

		if (view === "profile") {
			if (!args.name) return { data: { error: "Give a name for view=profile." } };
			const roster = await troopYouth(api, orgGuid);
			if ("error" in roster) return roster.error;
			const adults = await api.organizations.listOrganizationAdults({ organizationGuid: orgGuid, includeExpired: false });
			if (adults.error) return adults;
			const people = [
				...findPeople(roster.scouts, args.name).map((p) => ({ p, kind: "scout" })),
				...findPeople(adults.data.members as Any[], args.name).map((p) => ({ p, kind: "adult" })),
			];
			if (!people.length) return { data: { error: `No scout or adult on the Troop roster matches "${args.name}".` } };
			const out = await pool(people.slice(0, 6), 3, async ({ p, kind }: Any) => {
				const r = await personProfile(api, p.personGuid);
				if (r.error !== undefined) return { name: nameOf(p), type: kind, error: r.error };
				const d = r.data;
				return {
					name: nameOf(p),
					type: kind,
					emails: emails(d),
					phones: phones(d),
					swimmingClassification: d.sbExtendedProfile?.swimmingClassification || null,
					swimmingClassificationDate: dayOf(d.sbExtendedProfile?.swimmingClassificationDate),
					healthRecord: health(d.sbExtendedProfile, today),
				};
			});
			return { data: { matches: out } };
		}

		const roster = await troopYouth(api, orgGuid);
		if ("error" in roster) return roster.error;
		const scouts = args.name ? findPeople(roster.scouts, args.name) : roster.scouts;
		if (!scouts.length) return { data: { error: `No scout matches "${args.name}".` } };
		const failures: string[] = [];
		const rows = await pool(scouts, 4, async (s: Any) => {
			const r = await personProfile(api, s.personGuid);
			if (r.error !== undefined) {
				failures.push(nameOf(s));
				return null;
			}
			const d = r.data;
			if (view === "emails") {
				const e = emails(d);
				return { scout: nameOf(s), emails: e.length ? e : null };
			}
			if (view === "swim") {
				return {
					scout: nameOf(s),
					classification: d.sbExtendedProfile?.swimmingClassification || "Not recorded",
					date: dayOf(d.sbExtendedProfile?.swimmingClassificationDate),
				};
			}
			return { scout: nameOf(s), ...health(d.sbExtendedProfile, today) };
		});
		const list = rows.filter(Boolean) as Any[];
		if (view === "health") {
			const bad = list.filter((x) => !/within a year/.test(x.partsAB) || !/within a year/.test(x.partC));
			return {
				data: {
					needAttention: bad,
					okCount: list.length - bad.length,
					failures: failures.length ? failures : undefined,
					note: "Needs attention means Part A/B or Part C has no date or is dated over a year ago. Dates are as entered in Scoutbook.",
				},
			};
		}
		if (view === "swim") {
			const groups: Record<string, string[]> = {};
			for (const x of list) (groups[x.classification] ??= []).push(x.scout + (x.date ? ` (${x.date})` : ""));
			return { data: { byClassification: groups, failures: failures.length ? failures : undefined } };
		}
		return { data: { scouts: list, failures: failures.length ? failures : undefined } };
	},
});
