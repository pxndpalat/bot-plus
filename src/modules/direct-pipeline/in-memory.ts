import { createResponseClaimProof } from "../line-adapter/index.ts";
import type { ResponseClaim, ResponseClaimInput, ResponseClaimResult, ResponseClaimStore } from "./types.ts";

function copy(value: ResponseClaim): ResponseClaim {
  return {
    ...value,
    claimedAt: value.claimedAt ? new Date(value.claimedAt.getTime()) : null,
    deliveredAt: value.deliveredAt ? new Date(value.deliveredAt.getTime()) : null,
  };
}

export interface InMemoryResponseClaimStore extends ResponseClaimStore {
  readonly responses: readonly ResponseClaim[];
}

/** A synchronous map operation makes concurrent calls in one Bun process atomic before the first await. */
export function createInMemoryResponseClaimStore(idGenerator: () => string = () => crypto.randomUUID()): InMemoryResponseClaimStore {
  const records = new Map<string, ResponseClaim>();
  const store: InMemoryResponseClaimStore = {
    get responses() { return [...records.values()].map(copy); },
    async claim(input: ResponseClaimInput): Promise<ResponseClaimResult> {
      const existing = records.get(input.idempotencyKey);
      if (existing) return { claimed: false, duplicate: true, response: copy(existing) };
      const response: ResponseClaim = {
        responseId: input.responseId ?? idGenerator(), idempotencyKey: input.idempotencyKey, groupId: input.groupId,
        sourceMessageId: input.sourceMessageId ?? null, decisionId: input.decisionId ?? null, state: "claimed",
        claimedAt: new Date(input.claimedAt.getTime()), deliveredAt: null, suppressionReason: null,
      };
      records.set(input.idempotencyKey, response);
      return { claimed: true, duplicate: false, response: copy(response), claimProof: createResponseClaimProof(response.idempotencyKey, response.responseId) };
    },
    async markSent(responseId, deliveredAt) {
      const current = [...records.values()].find((item) => item.responseId === responseId);
      if (!current) throw new Error("Unknown response claim");
      const next = { ...current, state: "sent" as const, deliveredAt: new Date(deliveredAt.getTime()) };
      records.set(current.idempotencyKey, next);
      return copy(next);
    },
    async markUnknown(responseId, reason, at) {
      const current = [...records.values()].find((item) => item.responseId === responseId);
      if (!current) throw new Error("Unknown response claim");
      const next = { ...current, state: "unknown" as const, suppressionReason: reason, deliveredAt: new Date(at.getTime()) };
      records.set(current.idempotencyKey, next);
      return copy(next);
    },
    async markSuppressed(input, reason) {
      const existing = records.get(input.idempotencyKey);
      if (existing) return copy(existing);
      const next: ResponseClaim = {
        responseId: input.responseId ?? idGenerator(), idempotencyKey: input.idempotencyKey, groupId: input.groupId,
        sourceMessageId: input.sourceMessageId ?? null, decisionId: input.decisionId ?? null, state: "suppressed",
        claimedAt: null, deliveredAt: null, suppressionReason: reason,
      };
      records.set(input.idempotencyKey, next);
      return copy(next);
    },
  };
  return store;
}

export const createInMemoryResponseRepository = createInMemoryResponseClaimStore;

