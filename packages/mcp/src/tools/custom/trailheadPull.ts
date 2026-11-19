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

const mbStatus = (b: Any): "awarded" | "completed" | "in_progress" =>
	b.awardedDate || b.status === "Awarded"
		? "awarded"
		: b.leaderApprovedDate || /approved/i.test(String(b.status)) || Number(b.percentCompleted) >= 1
			? "completed"
			: "in_progress";

type Built = {
	rows: Any[];
	codeById: Map<string, string>;
	leafIds: Set<string>;
};

// Turns a flat Scoutbook requirement list (rank or merit badge, for a version or
// for one youth) into Trailhead's shape: codes like "6" and "6a", headers marked
// not checkable, each sub-item pointing at its header, in natural code order.
function buildRequirements(reqs: Any[]): Built {
	const byId = new Map(reqs.map((q) => [String(q.id), q]));
	const parentIds = new Set(
		reqs.map((q) => String(q.parentRequirementId ?? "")).filter(Boolean),
	);
	const codeOf = (q: Any, depth = 0): string => {
		const rn = clean(q.requirementNumber);
		if (rn) return rn.slice(0, 15);
		const ln = clean(q.listNumber).replace(/[().\s]/g, "");
		if (!ln) return "";
		const p = depth < 4 ? byId.get(String(q.parentRequirementId ?? "")) : undefined;
		return (p ? codeOf(p, depth + 1) + ln : ln).slice(0, 15);
	};
	const entries = reqs
		.map((q) => ({ q, code: codeOf(q), text: plain(q.name) }))
		.filter((e) => e.code && e.text)
		.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
	const seen = new Set<string>();
	const rows: Any[] = [];
	const codeById = new Map<string, string>();
	const leafIds = new Set<string>();
	for (const e of entries) {
		if (seen.has(e.code)) continue;
		seen.add(e.code);
		const id = String(e.q.id);
		const parent = byId.get(String(e.q.parentRequirementId ?? ""));
		const parentCode = parent ? codeOf(parent) : "";
		const checkable = !parentIds.has(id);
		codeById.set(id, e.code);
		if (checkable) leafIds.add(id);
		rows.push({
			code: e.code,
			text: e.text,
			checkable,
			parent_code: parentCode || null,
			sort_order: rows.length + 1,
		});
	}
	return { rows, codeById, leafIds };
}

const chunks = <T>(items: T[], n: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
	return out;
};

type MbVersion = {
	id: number;
	versionId: number;
	name: string;
	version: number;
	eagle: boolean;
	needsReqs: boolean;
	built?: Built;
};

export const trailheadPull = defineTool({
	name: "trailheadPull",
	title: "Build or send the Trailhead roster, rank and merit badge sync",
	description: [
		"Collects the troop roster, Scouts BSA rank data and merit badge data from the Scouting API in the shape Trailhead's sync.php expects: scouts (member ID, name, age, current position, last rank approved, renewal status, expiration), requirement lists (with grouped sub-requirements like 6a/6b) for every rank and merit badge version a scout is working on, each scout's progress, and which individual requirements each scout has already completed for the ranks and badges in progress.",
		"Read-only against Scoutbook. By default it only builds the payload and returns a summary (dry run). Set post=true to send it to Trailhead using the TRAILHEAD_URL and TRAILHEAD_API_KEY environment variables; it also logs a run in Trailhead unless logRun=false.",
		"Options: meritBadges=false leaves badges out; requirementStatus=false skips the per-requirement completion data (faster). Does not touch Trailhead's sign-off queue. Takes about 45 seconds with everything included.",
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
		requirementStatus: z
			.boolean()
			.optional()
			.describe(
				"Include which individual requirements each scout has completed, for ranks and badges in progress. Defaults to true.",
			),
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
		const orgGuid = orgGuidOf(args.organizationGuid);
		const today = new Date();
		const failures: string[] = [];
		const softFailures: string[] = [];
		const withBadges = args.meritBadges !== false;
		const withStatus = args.requirementStatus !== false;

		const roster = await troopYouth(api, orgGuid, true);
		if ("error" in roster) return roster.error;

		const scoutsOut: Any[] = [];
		const progressOut: Any[] = [];
		const mbProgress: Any[] = [];
		const mbVersions = new Map<string, MbVersion>();
		const versions = new Map<
			string,
			{ rankId: number; versionId: number; name: string; version: number; needsReqs: boolean }
		>();
		const rankWork: { scout: string; memberId: number; userId: number; rankId: number; name: string; version: number }[] = [];
		const mbWork = new Map<number, Map<number, number>>(); // badge id -> member id -> user id

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
				if (status === "in_progress") {
					entry.needsReqs = true;
					const members = mbWork.get(Number(b.id)) ?? new Map<number, number>();
					members.set(memberId, s.sbUserId);
					mbWork.set(Number(b.id), members);
				}
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
				if (status === "in_progress") {
					entry.needsReqs = true;
					rankWork.push({
						scout: nameOf(s),
						memberId,
						userId: s.sbUserId,
						rankId: rk.id,
						name: rk.name,
						version,
					});
				}
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
			return {
				name: v.name,
				version_year: v.version,
				requirements: buildRequirements(res.data.requirements ?? []).rows,
			};
		});

		// Requirement lists for each merit badge version someone is working on
		await pool([...mbVersions.values()], 4, async (v) => {
			if (!v.needsReqs) return;
			const res = await retry(() =>
				api.advancement.getMeritBadgeRequirements({ meritBadgeId: v.id, versionId: v.versionId }),
			);
			if (res.error) {
				failures.push(`${v.name} ${v.version}: requirement lookup failed`);
				return;
			}
			v.built = buildRequirements(res.data.requirements ?? []);
		});
		const badgeMap = new Map<string, Any>();
		for (const v of mbVersions.values()) {
			const badge = badgeMap.get(v.name) ?? { name: v.name, eagle_required: v.eagle, versions: [] };
			badge.versions.push({
				version_year: v.version,
				is_current: v.needsReqs,
				expiration_date: null,
				requirements: v.built?.rows ?? [],
			});
			badgeMap.set(v.name, badge);
		}
		const badgesOut = [...badgeMap.values()];

		// Which individual requirements each scout has completed
		const rankStatus: Any[] = [];
		const badgeStatus: Any[] = [];
		if (withStatus) {
			await pool(rankWork, 6, async (w) => {
				const res = await retry(() =>
					api.advancement.getYouthRankRequirements({ userId: w.userId, rankId: w.rankId }),
				);
				if (res.error) {
					softFailures.push(`${w.scout}: ${w.name} requirement status lookup failed`);
					return;
				}
				const reqs: Any[] = res.data.requirements ?? [];
				const built = buildRequirements(reqs);
				for (const q of reqs) {
					const id = String(q.id);
					const code = built.codeById.get(id);
					if (!code || !built.leafIds.has(id)) continue;
					const done = Boolean(q.completed);
					rankStatus.push({
						scout_id: w.memberId,
						rank_name: w.name,
						version_year: w.version,
						requirement_code: code,
						completed: done,
						completion_date: done
							? (day(q.dateCompleted) ?? day(q.leaderApprovedDate) ?? day(q.markedCompletedDate))
							: null,
					});
				}
			});

			await pool([...mbWork.entries()], 4, async ([badgeId, members]) => {
				const res = await retry(() =>
					api.advancement.listMemberMeritBadgeRequirements({
						organizationGuid: orgGuid,
						meritBadgeId: badgeId,
						memberId: [...members.keys()],
					}),
				);
				if (res.error) {
					softFailures.push(`merit badge ${badgeId}: requirement status lookup failed`);
					return;
				}
				for (const item of res.data as Any[]) {
					const v = mbVersions.get(`${badgeId}:${item.versionId}`);
					if (!v?.built) continue;
					for (const r of item.requirements ?? []) {
						const id = String(r.id);
						const code = v.built.codeById.get(id);
						if (!code || !v.built.leafIds.has(id)) continue;
						const done =
							r.status === "Leader Approved" || Boolean(r.dateCompleted) || Boolean(r.leaderApprovedDate);
						badgeStatus.push({
							scout_id: item.memberId,
							badge_name: v.name,
							version_year: v.version,
							requirement_code: code,
							completed: done,
							completion_date: done
								? (day(r.dateCompleted) ?? day(r.leaderApprovedDate) ?? day(r.markedCompletedDate))
								: null,
						});
					}
				}
			});
		}

		scoutsOut.sort((a, b) => a.name.localeCompare(b.name));
		const payload: Any = { scouts: scoutsOut, ranks: ranksOut, rank_progress: progressOut };
		if (withBadges) {
			payload.merit_badges = badgesOut;
			payload.merit_badge_progress = mbProgress;
		}
		const statusPayloads: Any[] = [
			...chunks(rankStatus, 1500).map((c) => ({ rank_requirement_status: c })),
			...chunks(badgeStatus, 1500).map((c) => ({ merit_badge_requirement_status: c })),
		];
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
			requirementStatus: withStatus
				? {
						rankRows: rankStatus.length,
						rankCompleted: rankStatus.filter((x) => x.completed).length,
						badgeRows: badgeStatus.length,
						badgeCompleted: badgeStatus.filter((x) => x.completed).length,
					}
				: undefined,
			failures: failures.length ? failures : undefined,
			statusLookupFailures: softFailures.length ? softFailures : undefined,
		};

		if (!args.post) {
			return {
				data: {
					dryRun: true,
					summary,
					sample: {
						scout: scoutsOut[0],
						rank: ranksOut.find((x) => x.requirements.some((q: Any) => q.parent_code)),
						rankStatus: rankStatus.slice(0, 4),
						badgeStatus: badgeStatus.slice(0, 4),
					},
					payload: args.includePayload ? { ...payload, rankStatus, badgeStatus } : undefined,
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
			let updated = 0;
			let ok = true;
			let failed: Any;
			let lastStatus = 200;
			// The main data goes first, then the requirement status in chunks, so each
			// request stays small and the requirements it refers to already exist
			for (const body of [payload, ...statusPayloads]) {
				const r = await send("sync.php", body);
				lastStatus = r.status;
				if (!r.ok) {
					ok = false;
					failed = r.json;
					break;
				}
				updated += Number(r.json?.updated ?? 0);
			}
			if (runId) {
				await send("sync-runs.php", {
					id: runId,
					pull_updated_count: updated,
					push_confirmed_count: 0,
					push_flagged_count: 0,
					status: ok ? "success" : "failed",
					fail_reason: ok ? null : JSON.stringify(failed).slice(0, 500),
				});
			}
			return {
				data: {
					sent: ok,
					httpStatus: lastStatus,
					updated,
					trailheadError: ok ? undefined : failed,
					requests: 1 + statusPayloads.length,
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
