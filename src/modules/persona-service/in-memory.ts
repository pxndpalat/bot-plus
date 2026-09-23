import { ConflictError } from "../../shared/index.ts";
import type { ObservationStore, PersonaAlias, PersonaFact, PersonaMember, PersonaObservation } from "./types.ts";

export interface InMemoryPersonaSeed { readonly member: PersonaMember; readonly aliases?: readonly string[]; }
function cloneMember(item: PersonaMember): PersonaMember { return { ...item, leftAt: item.leftAt ? new Date(item.leftAt.getTime()) : item.leftAt }; }
function cloneObservation(item: PersonaObservation): PersonaObservation { return { ...item, observedAt: new Date(item.observedAt.getTime()), invalidatedAt: item.invalidatedAt ? new Date(item.invalidatedAt.getTime()) : null, metadata: { ...item.metadata } }; }
function cloneFact(item: PersonaFact): PersonaFact { return { ...item, firstSeenAt: new Date(item.firstSeenAt.getTime()), lastSeenAt: new Date(item.lastSeenAt.getTime()), expiresOrDecayAt: new Date(item.expiresOrDecayAt.getTime()), archivedAt: item.archivedAt ? new Date(item.archivedAt.getTime()) : null, observationIds: [...item.observationIds] }; }

export interface InMemoryPersonaStore extends ObservationStore { readonly observations: readonly PersonaObservation[]; readonly facts: readonly PersonaFact[]; readonly aliases: readonly PersonaAlias[]; }

export function createInMemoryPersonaStore(seeds: readonly InMemoryPersonaSeed[] = []): InMemoryPersonaStore {
  const members = new Map<string, PersonaMember>(); const aliases: PersonaAlias[] = []; const observations: PersonaObservation[] = []; const facts: PersonaFact[] = [];
  for (const seed of seeds) { members.set(`${seed.member.groupId}:${seed.member.id}`, cloneMember(seed.member)); for (const alias of seed.aliases ?? []) aliases.push({ id: crypto.randomUUID(), groupId: seed.member.groupId, memberId: seed.member.id, alias, normalizedAlias: alias.trim().normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase(), isPrimary: false, createdAt: new Date(0) }); }
  return {
    get observations() { return observations.map(cloneObservation); }, get facts() { return facts.map(cloneFact); }, get aliases() { return aliases.map((item) => ({ ...item, createdAt: new Date(item.createdAt.getTime()) })); },
    async findMember(groupId, memberIdOrLineUserId) { const direct = members.get(`${groupId}:${memberIdOrLineUserId}`); return direct ? cloneMember(direct) : [...members.values()].find((item) => item.groupId === groupId && item.lineUserId === memberIdOrLineUserId) ? cloneMember([...members.values()].find((item) => item.groupId === groupId && item.lineUserId === memberIdOrLineUserId) as PersonaMember) : null; },
    async listMembers(groupId) { return [...members.values()].filter((item) => item.groupId === groupId).map(cloneMember); },
    async findAlias(groupId, alias) { const normalized = alias.trim().normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase(); return aliases.filter((item) => item.groupId === groupId && item.normalizedAlias === normalized).map((item) => ({ ...item, createdAt: new Date(item.createdAt.getTime()) })); },
    async addAlias(alias) { if (aliases.some((item) => item.groupId === alias.groupId && item.normalizedAlias === alias.normalizedAlias && item.memberId !== alias.memberId)) throw new ConflictError("Alias is already used by another member"); aliases.push({ ...alias, createdAt: new Date(alias.createdAt.getTime()) }); return alias; },
    async setMemoryOptOut(groupId, memberId, optedOut) { const key = `${groupId}:${memberId}`; const member = members.get(key); if (!member) throw new Error("Unknown member"); members.set(key, { ...member, memoryOptedOut: optedOut }); },
    async findObservation(groupId, input) { const hit = observations.find((item) => item.groupId === groupId && item.subjectMemberId === input.subjectMemberId && item.category === input.category && item.claim.trim().toLocaleLowerCase() === input.claim.trim().toLocaleLowerCase() && item.sourceMessageId === input.sourceMessageId); return hit ? cloneObservation(hit) : null; },
    async createObservation(observation) { const existing = observations.find((item) => item.groupId === observation.groupId && item.subjectMemberId === observation.subjectMemberId && item.category === observation.category && item.claim.trim().toLocaleLowerCase() === observation.claim.trim().toLocaleLowerCase() && item.sourceMessageId === observation.sourceMessageId); if (existing) return cloneObservation(existing); observations.push(cloneObservation(observation)); return cloneObservation(observation); },
    async listObservations(groupId, query = {}) { return observations.filter((item) => item.groupId === groupId && (query.subjectMemberId === undefined || String(item.subjectMemberId) === query.subjectMemberId) && (query.category === undefined || item.category === query.category) && (!query.activeOnly || item.status === "active")).map(cloneObservation); },
    async listFacts(query) { return facts.filter((item) => item.groupId === query.groupId && (query.subjectMemberId === undefined || String(item.subjectMemberId) === query.subjectMemberId) && (query.category === undefined || item.category === query.category) && (query.includeRisky || item.visibility !== "risky") && (query.visibility === undefined || query.visibility.includes(item.visibility))).map(cloneFact); },
    async createFact(fact) { const existing = facts.find((item) => String(item.id) === String(fact.id)); if (existing) return cloneFact(existing); facts.push(cloneFact(fact)); return cloneFact(fact); },
    async updateFact(fact) { const index = facts.findIndex((item) => String(item.id) === String(fact.id)); if (index < 0) facts.push(cloneFact(fact)); else facts[index] = cloneFact(fact); return cloneFact(fact); },
  };
}

export const createInMemoryPersonaRepository = createInMemoryPersonaStore;

