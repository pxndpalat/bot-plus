import type { FactVisibility, MemberId, ObservationId, FactId } from "../../shared/index.ts";

export const PERSONA_CATEGORIES = [
  "food", "hobby", "skill", "work", "travel", "relationship", "habit",
  "preference", "dislike", "nickname",
] as const;
export type PersonaCategory = typeof PERSONA_CATEGORIES[number];

export const OBSERVATION_SOURCE_STRENGTHS = [
  "self_explicit", "self_behavioral", "third_party", "self_correction",
] as const;
export type ObservationSourceStrength = typeof OBSERVATION_SOURCE_STRENGTHS[number];

export const SOURCE_WEIGHTS: Readonly<Record<ObservationSourceStrength, number>> = {
  self_explicit: 0.90,
  self_behavioral: 0.60,
  third_party: 0.30,
  self_correction: 1.00,
};

export interface PersonaMember {
  readonly id: MemberId | string;
  readonly groupId: string;
  readonly lineUserId: string;
  readonly displayName: string | null;
  readonly memoryOptedOut: boolean;
  readonly leftAt?: Date | null;
}

export interface PersonaAlias {
  readonly id: string;
  readonly groupId: string;
  readonly memberId: MemberId | string;
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly isPrimary: boolean;
  readonly createdAt: Date;
}

export interface PersonaObservation {
  readonly id: ObservationId | string;
  readonly groupId: string;
  readonly subjectMemberId: MemberId | string;
  readonly sourceMessageId: string | null;
  readonly extractedByMemberId: MemberId | string | null;
  readonly category: PersonaCategory;
  readonly claim: string;
  readonly sourceStrength: ObservationSourceStrength;
  readonly confidence: number;
  readonly visibility: FactVisibility;
  readonly status: "active" | "invalidated";
  readonly observedAt: Date;
  readonly invalidatedAt: Date | null;
  readonly invalidationReason: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface PersonaFact {
  readonly id: FactId | string;
  readonly groupId: string;
  readonly subjectMemberId: MemberId | string;
  readonly category: PersonaCategory;
  readonly claim: string;
  readonly confidence: number;
  readonly visibility: FactVisibility;
  readonly active: boolean;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresOrDecayAt: Date;
  readonly archivedAt: Date | null;
  readonly observationIds: readonly (ObservationId | string)[];
}

export interface PersonaExtractionCandidate {
  readonly category: PersonaCategory;
  readonly claim: string;
  /** A LINE user id/member id, when the extractor knows it. */
  readonly subjectMemberId?: string;
  /** A display name or alias to resolve. Never treated as canonical identity. */
  readonly subjectCandidate?: string;
  readonly sourceStrength: ObservationSourceStrength;
  readonly confidence: number;
  readonly visibility: FactVisibility;
  readonly observedAt?: Date | string;
  readonly sourceMessageId?: string;
  readonly extractedByMemberId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PersonaExtractionEnvelope {
  readonly observations: readonly PersonaExtractionCandidate[];
}

export interface AliasResolution {
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly memberId: string | null;
  readonly confidence: number;
  readonly ambiguous: boolean;
}

export interface PersonaFactQuery {
  readonly groupId: string;
  readonly subjectMemberId?: string;
  readonly category?: PersonaCategory;
  readonly minConfidence?: number;
  readonly visibility?: readonly FactVisibility[];
  readonly includeRisky?: boolean;
}

export interface ObservationStore {
  findMember(groupId: string, memberIdOrLineUserId: string): Promise<PersonaMember | null>;
  listMembers(groupId: string): Promise<readonly PersonaMember[]>;
  findAlias(groupId: string, alias: string): Promise<readonly PersonaAlias[]>;
  addAlias(alias: PersonaAlias): Promise<PersonaAlias>;
  setMemoryOptOut(groupId: string, memberId: string, optedOut: boolean): Promise<void>;
  findObservation(groupId: string, input: Pick<PersonaObservation, "subjectMemberId" | "category" | "claim" | "sourceMessageId">): Promise<PersonaObservation | null>;
  createObservation(observation: PersonaObservation): Promise<PersonaObservation>;
  listObservations(groupId: string, query?: { readonly subjectMemberId?: string; readonly category?: PersonaCategory; readonly activeOnly?: boolean }): Promise<readonly PersonaObservation[]>;
  listFacts(query: PersonaFactQuery): Promise<readonly PersonaFact[]>;
  createFact(fact: PersonaFact): Promise<PersonaFact>;
  updateFact(fact: PersonaFact): Promise<PersonaFact>;
}

/** Public name used by composition roots; the implementation remains a port. */
export type PersonaRepository = ObservationStore;

