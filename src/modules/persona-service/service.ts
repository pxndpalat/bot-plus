import { ConflictError, ValidationError, uuidIdGenerator, type IdGenerator } from "../../shared/index.ts";
import { factFromClaim, rankPersonaClaims } from "./resolver.ts";
import { validatePersonaExtraction } from "./extraction.ts";
import type { PersonaService } from "./ports.ts";
import type { ObservationStore } from "./types.ts";
import type { SafetyGate } from "../safety-gate/index.ts";
import type { AliasResolution, PersonaAlias, PersonaCategory, PersonaExtractionCandidate, PersonaFact, PersonaFactQuery, PersonaObservation } from "./types.ts";

function normalizeAlias(alias: string): string {
  return alias.trim().normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
}
function validDate(value: Date | string | undefined, fallback: Date): Date {
  const result = value === undefined ? new Date(fallback.getTime()) : value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new ValidationError("Persona date must be valid");
  return result;
}
function stableObservationId(sourceMessageId: string, subjectMemberId: string, category: string, claim: string): string {
  let hash = 2166136261;
  for (const character of `${sourceMessageId}\u0000${subjectMemberId}\u0000${category}\u0000${claim.trim().toLocaleLowerCase()}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `obs_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function stableFactId(groupId: string, subjectMemberId: string, category: string, claim: string): string {
  return stableObservationId(`${groupId}\u0000fact`, subjectMemberId, category, claim).replace(/^obs_/u, "fact_");
}

export interface PersonaServiceOptions { readonly idGenerator?: IdGenerator; readonly now?: () => Date; readonly safetyGate?: Pick<SafetyGate, "evaluate">; }

export function createPersonaService(store: ObservationStore, options: PersonaServiceOptions = {}): PersonaService {
  const ids = options.idGenerator ?? uuidIdGenerator();
  const clock = options.now ?? (() => new Date());
  const resolveAlias = async (groupId: string, alias: string): Promise<AliasResolution> => {
    const normalizedAlias = normalizeAlias(alias);
    if (!normalizedAlias) throw new ValidationError("Alias must be non-empty");
    const matches = await store.findAlias(groupId, normalizedAlias);
    const members = [...new Set(matches.map((item) => String(item.memberId)))];
    return { alias, normalizedAlias, memberId: members.length === 1 ? members[0] : null, confidence: members.length === 1 ? 1 : 0, ambiguous: members.length !== 1 };
  };
  const getMember = (groupId: string, memberId: string) => store.findMember(groupId, memberId);
  const addAlias = async (input: { readonly groupId: string; readonly memberId: string; readonly alias: string; readonly isPrimary?: boolean }): Promise<PersonaAlias> => {
    const member = await store.findMember(input.groupId, input.memberId);
    if (!member) throw new ValidationError("Unknown member for alias");
    const memberId = String(member.id);
    const normalizedAlias = normalizeAlias(input.alias);
    if (!normalizedAlias) throw new ValidationError("Alias must be non-empty");
    const matches = await store.findAlias(input.groupId, normalizedAlias);
    const existing = matches.find((item) => String(item.memberId) === memberId);
    if (existing) return existing;
    const collision = matches.find((item) => String(item.memberId) !== memberId);
    if (collision) throw new ConflictError("Alias is already used by another member", { field: "alias" });
    return store.addAlias({ id: String(ids.next()), groupId: input.groupId, memberId, alias: input.alias.trim(), normalizedAlias, isPrimary: input.isPrimary ?? false, createdAt: clock() });
  };
  const saveObservation = async (input: PersonaExtractionCandidate & { readonly groupId: string; readonly subjectMemberId: string; readonly now?: Date }): Promise<PersonaObservation | null> => {
    const member = await store.findMember(input.groupId, input.subjectMemberId);
    if (!member) throw new ValidationError("Unknown persona subject member");
    if (member.memoryOptedOut) return null;
    if (options.safetyGate) {
      const safety = await options.safetyGate.evaluate({ draft: input.claim, path: "ambient" });
      if (safety.status !== "allowed") return null;
    }
    const subjectMemberId = String(member.id);
    const observedAt = validDate(input.observedAt, input.now ?? clock());
    const duplicate = await store.findObservation(input.groupId, { subjectMemberId, category: input.category, claim: input.claim, sourceMessageId: input.sourceMessageId ?? null });
    if (duplicate) return duplicate;
    const id = input.sourceMessageId ? stableObservationId(input.sourceMessageId, subjectMemberId, input.category, input.claim) : String(ids.next());
    const observation: PersonaObservation = { id, groupId: input.groupId, subjectMemberId, sourceMessageId: input.sourceMessageId ?? null, extractedByMemberId: input.extractedByMemberId ?? null, category: input.category, claim: input.claim.trim(), sourceStrength: input.sourceStrength, confidence: input.confidence, visibility: input.visibility, status: "active", observedAt, invalidatedAt: null, invalidationReason: null, metadata: input.metadata ?? {} };
    return store.createObservation(observation);
  };
  const resolveFacts = async (groupId: string, subjectMemberId: string, category?: PersonaCategory, now = clock()): Promise<readonly PersonaFact[]> => {
    const member = await store.findMember(groupId, subjectMemberId);
    if (!member) throw new ValidationError("Unknown persona subject member");
    subjectMemberId = String(member.id);
    const categories = category ? [category] : [...new Set((await store.listObservations(groupId, { subjectMemberId, activeOnly: true })).map((item) => item.category))];
    const result: PersonaFact[] = [];
    for (const currentCategory of categories) {
      const observations = await store.listObservations(groupId, { subjectMemberId, category: currentCategory, activeOnly: true });
      const [selected] = rankPersonaClaims(observations, now);
      const existing = await store.listFacts({ groupId, subjectMemberId, category: currentCategory, includeRisky: true });
      for (const old of existing.filter((fact) => fact.active)) {
        if (!selected || old.claim.trim().toLocaleLowerCase() !== selected.claim.trim().toLocaleLowerCase()) await store.updateFact({ ...old, active: false, archivedAt: now });
      }
      if (!selected) continue;
      const same = existing.find((fact) => fact.claim.trim().toLocaleLowerCase() === selected.claim.trim().toLocaleLowerCase());
      const fact = factFromClaim({ id: same?.id ? String(same.id) : stableFactId(groupId, subjectMemberId, currentCategory, selected.claim), groupId, subjectMemberId, category: currentCategory, claim: selected, now });
      result.push(await (same ? store.updateFact(fact) : store.createFact(fact)));
    }
    return result;
  };
  const extractAndResolve = async (input: { readonly groupId: string; readonly extractorOutput: unknown; readonly sourceMessageId?: string; readonly extractedByMemberId?: string; readonly now?: Date }): Promise<readonly PersonaFact[]> => {
    const envelope = validatePersonaExtraction(input.extractorOutput);
    const now = input.now ?? clock();
    const touched = new Set<string>();
    for (const candidate of envelope.observations) {
      let subjectMemberId = candidate.subjectMemberId;
      if (!subjectMemberId && candidate.subjectCandidate) subjectMemberId = (await resolveAlias(input.groupId, candidate.subjectCandidate)).memberId ?? undefined;
      if (!subjectMemberId) continue;
      const saved = await saveObservation({ ...candidate, groupId: input.groupId, subjectMemberId, sourceMessageId: candidate.sourceMessageId ?? input.sourceMessageId, extractedByMemberId: candidate.extractedByMemberId ?? input.extractedByMemberId, now });
      if (saved) touched.add(`${subjectMemberId}:${candidate.category}`);
    }
    const facts: PersonaFact[] = [];
    for (const key of touched) { const [memberId, category] = key.split(":"); facts.push(...await resolveFacts(input.groupId, memberId, category as PersonaCategory, now)); }
    return facts;
  };
  return {
    resolveAlias, addAlias, getMember,
    setMemoryOptOut: async (groupId, memberId) => { const member = await store.findMember(groupId, memberId); if (!member) throw new ValidationError("Unknown member"); await store.setMemoryOptOut(groupId, String(member.id), true); },
    setMemoryOptIn: async (groupId, memberId) => { const member = await store.findMember(groupId, memberId); if (!member) throw new ValidationError("Unknown member"); await store.setMemoryOptOut(groupId, String(member.id), false); },
    isMemoryOptedOut: async (groupId, memberId) => (await store.findMember(groupId, memberId))?.memoryOptedOut ?? false,
    saveObservation, extractAndResolve, resolveFacts,
    getFacts: async (query: PersonaFactQuery) => {
      const facts = await store.listFacts(query);
      return facts.filter((fact) => fact.active && fact.confidence >= (query.minConfidence ?? 0)).filter((fact) => query.includeRisky === true || fact.visibility !== "risky");
    },
  };
}

