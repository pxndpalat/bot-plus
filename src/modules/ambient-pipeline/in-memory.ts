import { createResponseClaimProof, type ResponseClaimProof } from "../line-adapter/index.ts";
import type { AmbientCandidate, AmbientResponseClaimPort, AmbientSchedulePort, AmbientSuppression, AmbientSuppressionPort } from "./types.ts";

export function createInMemoryAmbientSchedulePort(): AmbientSchedulePort & { readonly candidates: readonly AmbientCandidate[] } {
  const candidates: AmbientCandidate[] = [];
  return {
    get candidates() { return candidates.map((candidate) => ({ ...candidate, dueAt: new Date(candidate.dueAt.getTime()), receivedAt: new Date(candidate.receivedAt.getTime()) })); },
    async schedule(candidate) { if (!candidates.some((item) => item.idempotencyKey === candidate.idempotencyKey)) candidates.push(candidate); return candidate; },
  };
}

export function createInMemoryAmbientSuppressionPort(): AmbientSuppressionPort & { readonly suppressions: readonly AmbientSuppression[] } {
  const suppressions: AmbientSuppression[] = [];
  return { get suppressions() { return suppressions.map((item) => ({ ...item, occurredAt: new Date(item.occurredAt.getTime()), metadata: item.metadata && { ...item.metadata } })); }, async record(item) { suppressions.push({ ...item, occurredAt: new Date(item.occurredAt.getTime()), metadata: item.metadata && { ...item.metadata } }); } };
}

export function createInMemoryAmbientResponseClaims(): AmbientResponseClaimPort & { readonly claims: ReadonlyMap<string, ResponseClaimProof> } {
  const claims = new Map<string, ResponseClaimProof>();
  return {
    claims,
    async claim(input) {
      const existing = claims.get(input.idempotencyKey);
      if (existing) return null;
      const proof = createResponseClaimProof(input.idempotencyKey, `response:${input.idempotencyKey}`);
      claims.set(input.idempotencyKey, proof);
      return proof;
    },
  };
}
