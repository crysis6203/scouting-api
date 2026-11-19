import { z } from "zod";
import { defineTool } from "../define.ts";
import { leaderContacts } from "./eventContacts.ts";
import { type Any, findPeople, nameOf, norm, orgGuidOf, troopYouth } from "./troopCommon.ts";

export const contactLookup = defineTool({
	name: "contactLookup",
	title: "Look up a scout's or leader's contact details",
	description:
		"Finds a scout or adult by name and returns phone numbers and emails. Scoutbook keeps contact details on parents, not scouts, so for a scout this returns his parents' emails and phones. For an adult it returns their own details when they are a parent of a troop scout, or from the local leader contact file. Use for 'what is Keaton's email?' or 'what is Mr. Phibbs' phone number?'.",
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		name: z.string().describe("Scout or adult name, e.g. 'Keaton Powell'"),
		includeAddress: z.boolean().optional().describe("Include mailing addresses. Default false."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const api = scouting.api as Any;
		const orgGuid = orgGuidOf(args.organizationGuid);

		const [roster, adultsRes, parentsRes] = await Promise.all([
			troopYouth(api, orgGuid),
			api.organizations.listOrganizationAdults({ organizationGuid: orgGuid, includeExpired: false }),
			api.organizations.listUnitParents({ organizationGuid: orgGuid }),
		]);
		if ("error" in roster) return roster.error;
		if (adultsRes.error) return adultsRes;
		if (parentsRes.error) return parentsRes;

		const rec = (info: Any) => ({
			name: info.personFullName,
			email: info.email || null,
			mobilePhone: info.mobilePhone || null,
			homePhone: info.homePhone || null,
			workPhone: info.workPhone || null,
			...(args.includeAddress
				? {
						address: [info.address1, info.address2, info.city, info.state, info.zip]
							.filter(Boolean)
							.join(", "),
					}
				: {}),
		});

		const parentsOf = new Map<number, Any[]>();
		const parentByUser = new Map<number, Any>();
		const parentByGuid = new Map<string, Any>();
		for (const link of parentsRes.data as Any[]) {
			if (!link.parentInformation) continue;
			const r = rec(link.parentInformation);
			if (link.youthUserId != null) {
				parentsOf.set(link.youthUserId, [...(parentsOf.get(link.youthUserId) ?? []), r]);
			}
			if (link.parentUserId != null) parentByUser.set(link.parentUserId, r);
			if (link.parentInformation.personGuid) {
				parentByGuid.set(String(link.parentInformation.personGuid).toLowerCase(), r);
			}
		}

		const results: Any[] = [];
		for (const s of findPeople(roster.scouts, args.name)) {
			const parents = parentsOf.get(s.sbUserId) ?? [];
			results.push({
				name: nameOf(s),
				type: "scout",
				parents,
				note: parents.length
					? "Scoutbook stores no email or phone for the scout himself, so these are his parents'."
					: "No parent contact records found for this scout.",
			});
		}

		const adults = new Map<string, Any>();
		for (const a of adultsRes.data.members as Any[]) adults.set(String(a.personGuid), a);
		const local = leaderContacts();
		for (const a of findPeople([...adults.values()], args.name)) {
			const own =
				parentByUser.get(a.sbUserId) ??
				parentByGuid.get(String(a.personGuid).toLowerCase());
			let contact: Any = own ?? null;
			let source = own ? "Scoutbook parent record" : null;
			if (!contact) {
				const keys = [
					norm(`${a.firstName} ${a.lastName}`),
					norm(`${a.nickName ?? ""} ${a.lastName}`),
					norm(a.personFullName),
				];
				const hit = keys.map((k) => local.byName.get(k)).find(Boolean);
				if (hit) {
					contact = { name: nameOf(a), email: hit.email, mobilePhone: hit.phone };
					source = "local leader contact file";
				}
			}
			results.push({
				name: nameOf(a),
				type: "adult",
				contact,
				source,
				note: contact
					? undefined
					: "No email or phone on file. Add this leader to the local leader contact file.",
			});
		}

		if (results.length === 0) {
			return { data: { error: `No scout or adult on the Troop roster matches "${args.name}".` } };
		}
		return { data: { matches: results } };
	},
});
