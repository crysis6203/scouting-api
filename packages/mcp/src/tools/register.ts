import type { McpServer } from "@modelcontextprotocol/server";
import type { ScoutingClient } from "scouting-api";
import { operations as apiOperations } from "./generated/api.scouting.org/index.ts";
import { auditAdvancement } from "./custom/auditAdvancement.ts";
import { auditCalendar } from "./custom/auditCalendar.ts";
import { auditCall } from "./custom/auditCall.ts";
import { auditRaw } from "./custom/auditRaw.ts";
import { eventContacts } from "./custom/eventContacts.ts";
import { eventRsvps } from "./custom/eventRsvps.ts";
import { contactLookup } from "./custom/contactLookup.ts";
import { meritBadgeProgress } from "./custom/meritBadgeProgress.ts";
import { meritBadgeCounselors } from "./custom/meritBadgeCounselors.ts";
import { personProfileTool } from "./custom/personProfile.ts";
import { troopBalances } from "./custom/troopBalances.ts";
import { troopAdvancement } from "./custom/troopAdvancement.ts";
import { troopRoster } from "./custom/troopRoster.ts";
import { looseOutput } from "./looseOutput.ts";
import { remainingRequirements } from "./custom/remainingRequirements.ts";
import { operations as scoutConnectOperations } from "./generated/scoutconnect-api.scouting.org/index.ts";

const operations = [
	...apiOperations,
	...scoutConnectOperations,
	remainingRequirements,
	eventRsvps,
	eventContacts,
	troopAdvancement,
	meritBadgeProgress,
	contactLookup,
	troopRoster,
	personProfileTool,
	meritBadgeCounselors,
	troopBalances,
	// Debug only: crawls the API and checks raw responses against the spec
	...(process.env["SCOUTING_AUDIT"] ? [auditAdvancement, auditCalendar, auditCall, auditRaw] : []),
];

// Without a sign-in, leaves out the tools that need one
export function registerTools(
	server: McpServer,
	scouting: ScoutingClient,
	signedIn: boolean,
) {
	for (const operation of operations) {
		if (operation.requiresAuth && !signedIn) continue;
		server.registerTool(
			operation.name,
			{
				title: operation.title,
				description: operation.description,
				inputSchema: operation.input,
				outputSchema: operation.output && looseOutput(operation.output),
				annotations: {
					readOnlyHint: operation.readOnly ?? undefined,
				},
			},
			async (args) => {
				const { data, error, response } = await operation.call(scouting, args);
				// The SDK turns a thrown error into an isError result. There's no
				// response when the request never reached the API.
				if (error) {
					throw new Error(JSON.stringify({ status: response?.status, error }));
				}

				return {
					content: [{ type: "text", text: JSON.stringify(data) }],
					structuredContent: data,
				};
			},
		);
	}

	return server;
}
