import type { PersonaCategory, PersonaExtractionCandidate, PersonaFact, PersonaFactQuery, PersonaMember, PersonaObservation, PersonaAlias, AliasResolution } from "./types.ts";

export interface PersonaService {
  resolveAlias(groupId: string, alias: string): Promise<AliasResolution>;
  addAlias(input: { readonly groupId: string; readonly memberId: string; readonly alias: string; readonly isPrimary?: boolean }): Promise<PersonaAlias>;
  setMemoryOptOut(groupId: string, memberId: string): Promise<void>;
  setMemoryOptIn(groupId: string, memberId: string): Promise<void>;
  isMemoryOptedOut(groupId: string, memberId: string): Promise<boolean>;
  saveObservation(input: PersonaExtractionCandidate & { readonly groupId: string; readonly subjectMemberId: string; readonly now?: Date }): Promise<PersonaObservation | null>;
  extractAndResolve(input: { readonly groupId: string; readonly extractorOutput: unknown; readonly sourceMessageId?: string; readonly extractedByMemberId?: string; readonly now?: Date }): Promise<readonly PersonaFact[]>;
  resolveFacts(groupId: string, subjectMemberId: string, category?: PersonaCategory, now?: Date): Promise<readonly PersonaFact[]>;
  getFacts(query: PersonaFactQuery): Promise<readonly PersonaFact[]>;
  getMember(groupId: string, memberIdOrLineUserId: string): Promise<PersonaMember | null>;
}

