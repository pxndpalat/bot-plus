import { SOURCE_WEIGHTS, type PersonaFact, type PersonaObservation } from "./types.ts";

export const PERSONA_DECAY_DAYS = 180;
const DAY_MS = 86_400_000;
const visibilityRank = { public_safe: 0, private: 1, risky: 2 } as const;

export interface ScoredPersonaClaim {
  readonly claim: string;
  readonly observations: readonly PersonaObservation[];
  readonly score: number;
  readonly confidence: number;
  readonly visibility: PersonaObservation["visibility"];
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

function recency(observedAt: Date, now: Date): number {
  const age = Math.max(0, now.getTime() - observedAt.getTime());
  return Math.max(0, 1 - age / (PERSONA_DECAY_DAYS * DAY_MS));
}

/** Deterministic resolver: evidence is retained; only the selected summary changes. */
export function rankPersonaClaims(observations: readonly PersonaObservation[], now: Date): readonly ScoredPersonaClaim[] {
  const groups = new Map<string, PersonaObservation[]>();
  for (const observation of observations) {
    if (observation.status !== "active" || observation.invalidatedAt !== null) continue;
    const key = observation.claim.trim().toLocaleLowerCase();
    const current = groups.get(key) ?? [];
    current.push(observation);
    groups.set(key, current);
  }
  return [...groups.values()].map((items) => {
    const sorted = [...items].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || String(b.id).localeCompare(String(a.id)));
    const score = Math.min(1, items.reduce((sum, item) => sum + SOURCE_WEIGHTS[item.sourceStrength] * item.confidence * recency(item.observedAt, now), 0) + Math.min(0.2, Math.max(0, items.length - 1) * 0.05));
    const confidence = Math.min(1, score);
    const firstSeenAt = new Date(Math.min(...items.map((item) => item.observedAt.getTime())));
    const lastSeenAt = new Date(Math.max(...items.map((item) => item.observedAt.getTime())));
    return { claim: sorted[0].claim, observations: sorted, score, confidence, visibility: sorted.reduce((visibility, item) => visibilityRank[item.visibility] > visibilityRank[visibility] ? item.visibility : visibility, "public_safe" as PersonaObservation["visibility"]), firstSeenAt, lastSeenAt };
  }).sort((a, b) => b.score - a.score || b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.claim.localeCompare(b.claim));
}

export function factFromClaim(input: { readonly id: string; readonly groupId: string; readonly subjectMemberId: string; readonly category: PersonaFact["category"]; readonly claim: ScoredPersonaClaim; readonly now: Date; }): PersonaFact {
  const decay = new Date(input.claim.lastSeenAt.getTime() + PERSONA_DECAY_DAYS * DAY_MS);
  return { id: input.id, groupId: input.groupId, subjectMemberId: input.subjectMemberId, category: input.category, claim: input.claim.claim, confidence: input.claim.confidence, visibility: input.claim.visibility, active: true, firstSeenAt: input.claim.firstSeenAt, lastSeenAt: input.claim.lastSeenAt, expiresOrDecayAt: decay, archivedAt: null, observationIds: input.claim.observations.map((observation) => observation.id) };
}

