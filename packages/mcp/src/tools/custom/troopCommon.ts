// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the spec's schemas
export type Any = any;

// Troop 0911 by default; set SCOUTING_ORG_GUID to use another unit
export const DEFAULT_ORG_GUID = "fd33d07b-86d3-4f30-9743-004866f9fc59";
export const orgGuidOf = (arg?: string) =>
	arg ?? process.env["SCOUTING_ORG_GUID"] ?? DEFAULT_ORG_GUID;

// Scouts BSA rank ids from the rank list
export const RANKS: Record<string, [number, string]> = {
	scout: [1, "Scout"],
	tenderfoot: [2, "Tenderfoot"],
	"second class": [3, "Second Class"],
	"first class": [4, "First Class"],
	star: [5, "Star Scout"],
	"star scout": [5, "Star Scout"],
	life: [6, "Life Scout"],
	"life scout": [6, "Life Scout"],
	eagle: [7, "Eagle Scout"],
	"eagle scout": [7, "Eagle Scout"],
};

export const norm = (v: unknown) =>
	String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
export const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
export const clean = (s: unknown) =>
	String(s ?? "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
export const nameOf = (m: Any) =>
	`${m.nickName || m.firstName} ${m.lastName}`.replace(/\s+/g, " ").trim();

// Runs fn over items, n at a time, keeping the order of the results
export async function pool<T, R>(
	items: T[],
	n: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

// The roster lists a youth once per position, so de-duplicate by sbUserId
export async function troopYouth(
	api: Any,
	organizationGuid: string,
	registrationDetails = false,
): Promise<{ error: Any } | { scouts: Any[] }> {
	const res = await api.organizations.listOrganizationYouths({
		organizationGuid,
		includeExpired: false,
		...(registrationDetails ? { includeRegistrationDetails: true } : {}),
	});
	if (res.error) return { error: res };
	const byId = new Map<number, Any>();
	for (const m of res.data.members) {
		const prev = byId.get(m.sbUserId);
		// keep the row that carries registration details
		if (!prev || (!prev.registrarInfo && m.registrarInfo)) byId.set(m.sbUserId, m);
	}
	return { scouts: [...byId.values()] };
}

export function findPeople(people: Any[], query: string): Any[] {
	const q = norm(query);
	return people.filter((m) => {
		const full = norm(`${m.firstName} ${m.lastName}`);
		const nick = norm(`${m.nickName ?? ""} ${m.lastName}`);
		return (
			norm(m.personFullName).includes(q) || full.includes(q) || nick.includes(q)
		);
	});
}

// Splits a Scouts BSA rank list out of a listYouthRanks response
export function scoutsBsaRanks(data: Any): Any[] {
	const programs: Any[] = data?.program ?? [];
	const p = programs.find((x) => /scouts bsa/i.test(String(x.program)));
	return [...(p?.ranks ?? [])].sort(
		(a: Any, b: Any) => (a.level ?? a.id) - (b.level ?? b.id),
	);
}
export const isAwarded = (r: Any) =>
	Boolean(r.awarded) || r.status === "Awarded" || Boolean(r.awardedDate);

export const rankDate = (r: Any) =>
	day(r.awardedDate) ?? day(r.dateEarned) ?? day(r.leaderApprovedDate);

export const daysBetween = (a: Date, b: Date) =>
	Math.round((b.getTime() - a.getTime()) / 86_400_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Scoutbook sometimes answers 5xx or 429 under load; retry those a couple of times
export async function retry(
	fn: () => Promise<Any>,
	tries = 3,
): Promise<Any> {
	let last: Any;
	for (let i = 0; i < tries; i++) {
		last = await fn();
		const status = last?.response?.status;
		if (!last?.error || (status !== undefined && status < 500 && status !== 429)) return last;
		await sleep(500 * (i + 1));
	}
	return last;
}
