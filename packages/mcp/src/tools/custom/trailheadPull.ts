import { z } from "zod";
import { defineTool } from "../define.ts";
import {
	type Any,
	clean,
	day,
	isAwarded,
	nameOf,
	orgGuidOf,
	pool,
	retry,
	scoutsBsaRanks,
	troopYouth,
} from "./troopCommon.ts";

// Builds the payload for Trailhead's POST /api/sync.php (the pull half of the
// Trailhead <-> Scoutbook sync) from the Scouting API, and optionally sends it.
// Needs TRAILHEAD_URL (the .../api folder) and TRAILHEAD_API_KEY to send.

const ageOn = (dob: string | null | undefined, today: Date) => {
	if (!dob) return null;
	const d = new Date(`${String(dob).slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return null;
	let age = today.getUTCFullYear() - d.getUTCFullYear();
	const before =
		today.getUTCMonth() < d.getUTCMonth() ||
		(today.getUTCMonth() === d.getUTCMonth() && today.getUTCDate() < d.getUTCDate());
	if (before) age -= 1;
	return age;
};

// "Eligible to Renew (unit only)" -> "Eligible to Renew" (column holds 20 characters)
const renewal = (s: unknown) =>
	String(s ?? "").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim().slice(0, 20) || null;

// Drops the "Resources" video links Scoutbook puts inside requirement text
const plain = (s: unknown) => clean(String(s ?? "").replace(/<details>[\s\S]*?<\/details>/gi, " "));

// Scoutbook's sortOrder like "1.10" -> a number that sorts 1.2 before 1.10
const order = (q: Any) => {
	const [a = "0", b = "0"] = String(q.sortOrder ?? "").split(".");
	return Number(a) * 1000 + Number(b);
};

const mbStatus = (b: Any): "awarded" | "completed" | "in_progress" =>
	b.awardedDate || b.status === "Awarded"
		? "awarded"
		: b.leaderApprovedDate || /approved/i.test(String(b.status)) || Number(b.percentCompleted) >= 1
			? "completed"
			: "in_progress";

const reqCode = (r: Any) =>
	(clean(r.requirementNumber) || clean(r.listNumber)).replace(/[().\s]/g, "").slice(0, 10);

export const trailheadPull = defineTool({
	name: "trailheadPull",
	title: "Build or send the Trailhead roster and rank sync",
	description: [
		"Collects the troop roster and Scouts BSA rank data from the Scouting API in the shape Trailhead's sync.php expects: scouts (member ID, name, age, current position, last rank approved, renewal status, expiration), rank requirement lists for every rank version a scout is working on, and each scout's rank progress (in_progress, completed = approved but not yet awarded, awarded).",
		"Read-only against Scoutbook. By default it only builds the payload and returns a summary (dry run). Set post=true to send it to Trailhead using the TRAILHEAD_URL and TRAILHEAD_API_KEY environment variables; it also logs a run in Trailhead unless logRun=false.",
		"Does not touch Trailhead's sign-off queue. Includes merit badges (requirement lists and each scout's progress) unless meritBadges=false. Takes about 30 seconds.",
	].join(" "),
	readOnly: true,
	requiresAuth: true,
	input: z.object({
		post: z
			.boolean()
			.optional()
			.describe("Send the payload to Trailhead. Defaults to false (dry run)."),
		meritBadges: z
			.boolean()
			.optional()
			.describe("Include merit badges (requirements and each scout's progress). Defaults to true."),
		logRun: z
			.boolean()
			.optional()
			.describe(
				"With post=true, also record a 'manual_pull' run in Trailhead's sync history. Defaults to true. Use false when another run log already covers this pull.",
			),
		includePayload: z
			.boolean()
			.optional()
			.describe("Return the whole payload as well as the summary. Large; for debugging."),
		organizationGuid: z.string().optional().describe("Defaults to Troop 0911."),
	}),
	call: async (scouting, args) => {
		const t0 = Date.now();
		const api = scouting.api as Any;
		const today = new Date();
		const failures: string[] = [];

		const roster = await troopYouth(api, orgGuidOf(args.organizationGuid), true);
		if ("error" in roster) return roster.error;

		const scoutsOut: Any[] = [];
		const progressOut: Any[] = [];
		const withBadges = args.meritBadges !== false;
		const mbProgress: Any[] = [];
		const mbVersions = new Map<
			string,
			{ id: number; versionId: number; name: string; version: number; eagle: boolean; needsReqs: boolean }
		>();
		const versions = new Map<
			string,
			{ rankId: number; versionId: number; name: string; version: number; needsReqs: boolean }
		>();

		await pool(roster.scouts, 4, async (s: Any) => {
			const [r, h, mb] = await Promise.all([
				retry(() => api.advancement.listYouthRanks({ userId: s.sbUserId })),
				retry(() => api.advancement.listYouthLeadershipPositionHistory({ userId: s.sbUserId })),
				withBadges
					? retry(() => api.advancement.listYouthMeritBadges({ userId: s.sbUserId }))
					: Promise.resolve({ data: [] }),
			]);
			if (r.error) {
				failures.push(`${nameOf(s)}: rank lookup failed`);
				return;
			}
			const memberId = Number.parseInt(String(s.memberId), 10);
			if (!Number.isFinite(memberId)) {
				failures.push(`${nameOf(s)}: no BSA member ID`);
				return;
			}
			const ranks = scoutsBsaRanks(r.data);
			const earned = ranks.filter((x: Any) => isAwarded(x) || Number(x.percentCompleted) >= 1);
			const last = earned[earned.length - 1];
			const firstOpen = ranks.find((x: Any) => !isAwarded(x) && Number(x.percentCompleted) < 1);
			const positions = h.error
				? ""
				: [
						...new Set(
							(h.data as Any[]).filter((x) => !x.endDate).map((x) => String(x.position)),
						),
					].join(", ");
			if (h.error) failures.push(`${nameOf(s)}: position lookup failed`);

			scoutsOut.push({
				id: memberId,
				name: nameOf(s),
				member_type: "youth",
				age: ageOn(s.registrarInfo?.dateOfBirth, today),
				patrol: null,
				position: positions ? positions.slice(0, 60) : null,
				last_rank_approved: last?.name ?? null,
				renewal_status: renewal(s.registrarInfo?.renewalStatus),
				expiration_date: day(s.registrarInfo?.registrationExpireDt),
			});

			if (mb.error) failures.push(`${nameOf(s)}: merit badge lookup failed`);
			for (const b of mb.error ? [] : (mb.data as Any[])) {
				const version = Number.parseInt(String(b.version), 10);
				if (!Number.isFinite(version)) continue;
				const status = mbStatus(b);
				mbProgress.push({ scout_id: memberId, badge_name: b.name, version_year: version, status });
				const key = `${b.id}:${b.versionId}`;
				const entry = mbVersions.get(key) ?? {
					id: Number(b.id),
					versionId: Number(b.versionId),
					name: b.name,
					version,
					eagle: Boolean(b.isEagleRequired),
					needsReqs: false,
				};
				if (status === "in_progress") entry.needsReqs = true;
				mbVersions.set(key, entry);
			}

			for (const rk of ranks) {
				const version = Number.parseInt(String(rk.version), 10);
				if (!Number.isFinite(version)) continue;
				let status: "awarded" | "completed" | "in_progress" | null = null;
				if (isAwarded(rk)) status = "awarded";
				else if (Number(rk.percentCompleted) >= 1) status = "completed";
				else if (Number(rk.percentCompleted) > 0 || rk === firstOpen) status = "in_progress";
				if (!status) continue;
				progressOut.push({
					scout_id: memberId,
					rank_name: rk.name,
					version_year: version,
					status,
				});
				const key = `${rk.id}:${rk.versionId}`;
				const entry = versions.get(key) ?? {
					rankId: rk.id,
					versionId: rk.versionId,
					name: rk.name,
					version,
					needsReqs: false,
				};
				if (status === "in_progress") entry.needsReqs = true;
				versions.set(key, entry);
			}
		});

		// Requirement lists for each rank version someone is working on
		const ranksOut = await pool([...versions.values()], 4, async (v) => {
			if (!v.needsReqs) return { name: v.name, version_year: v.version, requirements: [] as Any[] };
			const res = await retry(() =>
				api.advancement.getRankRequirementsV2({ rankId: v.rankId, versionId: v.versionId }),
			);
			if (res.error) {
				failures.push(`${v.name} ${v.version}: requirement lookup failed`);
				return { name: v.name, version_year: v.version, requirements: [] as Any[] };
			}
			const reqs: Any[] = res.data.requirements ?? [];
			const parents = new Set(reqs.map((q) => String(q.parentRequirementId ?? "")).filter(Boolean));
			const leaves = reqs
				.filter((q) => !parents.has(String(q.id)))
				.sort((x, y) => order(x) - order(y));
			const seen = new Set<string>();
			const out: Any[] = [];
			leaves.forEach((q, i) => {
				const code = reqCode(q);
				if (!code || seen.has(code)) return;
				seen.add(code);
				out.push({ code, text: clean(q.name) || clean(q.short), sort_order: i + 1 });
			});
			return { name: v.name, version_year: v.version, requirements: out };
		});

		// Merit badge requirement lists for each badge version someone is working on
		const mbReqs = await pool([...mbVersions.values()], 4, async (v) => {
			if (!v.needsReqs) return { v, requirements: [] as Any[] };
			const res = await retry(() =>
				api.advancement.getMeritBadgeRequirements({ meritBadgeId: v.id, versionId: v.versionId }),
			);
			if (res.error) {
				failures.push(`${v.name} ${v.version}: requirement lookup failed`);
				return { v, requirements: [] as Any[] };
			}
			const reqs: Any[] = res.data.requirements ?? [];
			const byId = new Map(reqs.map((q) => [String(q.id), q]));
			const parentIds = new Set(reqs.map((q) => String(q.parentRequirementId ?? "")).filter(Boolean));
			const codeOf = (q: Any, depth = 0): string => {
				const rn = clean(q.requirementNumber);
				if (rn) return rn.slice(0, 15);
				const ln = clean(q.listNumber).replace(/[().\s]/g, "");
				if (!ln) return "";
				const p = depth < 4 ? byId.get(String(q.parentRequirementId ?? "")) : undefined;
				return (p ? codeOf(p, depth + 1) + ln : ln).slice(0, 15);
			};
			const seen = new Set<string>();
			const out: Any[] = [];
			[...reqs]
				.sort((x, y) => order(x) - order(y))
				.forEach((q) => {
					const code = codeOf(q);
					const text = plain(q.name);
					if (!code || !text || seen.has(code)) return;
					seen.add(code);
					const parent = byId.get(String(q.parentRequirementId ?? ""));
					const parentCode = parent ? codeOf(parent) : "";
					out.push({
						code,
						text,
						checkable: !parentIds.has(String(q.id)),
						parent_code: parentCode || null,
						sort_order: out.length + 1,
					});
				});
			return { v, requirements: out };
		});
		const badgeMap = new Map<string, Any>();
		for (const { v, requirements } of mbReqs) {
			const badge = badgeMap.get(v.name) ?? { name: v.name, eagle_required: v.eagle, versions: [] };
			badge.versions.push({
				version_year: v.version,
				is_current: v.needsReqs,
				expiration_date: null,
				requirements,
			});
			badgeMap.set(v.name, badge);
		}
		const badgesOut = [...badgeMap.values()];

		scoutsOut.sort((a, b) => a.name.localeCompare(b.name));
		const payload: Any = { scouts: scoutsOut, ranks: ranksOut, rank_progress: progressOut };
		if (withBadges) {
			payload.merit_badges = badgesOut;
			payload.merit_badge_progress = mbProgress;
		}
		const summary: Any = {
			scouts: scoutsOut.length,
			rankVersions: ranksOut.length,
			requirements: ranksOut.reduce((n, x) => n + x.requirements.length, 0),
			rankProgressRows: progressOut.length,
			inProgress: progressOut.filter((p) => p.status === "in_progress").length,
			meritBadges: withBadges
				? {
						badges: badgesOut.length,
						requirements: badgesOut.reduce(
							(n: number, b: Any) =>
								n + b.versions.reduce((m: number, x: Any) => m + x.requirements.length, 0),
							0,
						),
						progressRows: mbProgress.length,
						inProgress: mbProgress.filter((p) => p.status === "in_progress").length,
					}
				: undefined,
			failures: failures.length ? failures : undefined,
		};

		if (!args.post) {
			return {
				data: {
					dryRun: true,
					summary,
					sample: {
						scout: scoutsOut[0],
						rank: ranksOut.find((x) => x.requirements.length),
						badge: badgesOut.find((b: Any) => b.versions.some((x: Any) => x.requirements.length)),
					},
					payload: args.includePayload ? payload : undefined,
					elapsedSeconds: Math.round((Date.now() - t0) / 100) / 10,
				},
			};
		}

		const base = (process.env["TRAILHEAD_URL"] ?? "").replace(/\/+$/, "");
		const key = process.env["TRAILHEAD_API_KEY"];
		if (!base || !key) {
			return {
				data: {
					error:
						"Set TRAILHEAD_URL (the .../api folder) and TRAILHEAD_API_KEY in the MCP server's environment to send.",
					summary,
				},
			};
		}
		if (failures.length > 0) {
			return {
				data: {
					error: "Not sent: some Scoutbook lookups failed, so the data would be incomplete. Run again.",
					summary,
				},
			};
		}
		const headers = { "Content-Type": "application/json", "X-API-Key": key };
		const send = async (path: string, body: unknown) => {
			const res = await fetch(`${base}/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
			const text = await res.text();
			let json: Any;
			try {
				json = JSON.parse(text);
			} catch {
				json = { raw: text.slice(0, 300) };
			}
			return { ok: res.ok, status: res.status, json };
		};
		try {
			const logRun = args.logRun !== false;
			const run = logRun ? await send("sync-runs.php", { run_type: "manual_pull" }) : undefined;
			const runId: number | undefined = run?.json?.id;
			const sync = await send("sync.php", payload);
			if (runId) {
				await send("sync-runs.php", {
					id: runId,
					pull_updated_count: sync.json?.updated ?? 0,
					push_confirmed_count: 0,
					push_flagged_count: 0,
					status: sync.ok ? "success" : "failed",
					fail_reason: sync.ok ? null : JSON.stringify(sync.json).slice(0, 500),
				});
			}
			return {
				data: {
					sent: sync.ok,
					httpStatus: sync.status,
					trailheadResponse: sync.json,
					runId,
					summary,
					elapsedSeconds: Math.round((Date.now() - t0) / 100) / 10,
				},
			};
		} catch (e) {
			return { data: { error: `Could not reach Trailhead: ${String(e)}`, summary } };
		}
	},
});
