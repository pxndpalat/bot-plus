import { ValidationError, type Clock } from "../../shared/index.ts";
import type { LifecycleRepository, RetentionPolicyProvider } from "./ports.ts";
import type { ForgetInput, LifecycleService, RetentionSweepInput, UnsendInput } from "./types.ts";

const systemClock: Clock = { now: () => new Date() };
function at(value: Date | undefined, clock: Clock): Date { const result = value ? new Date(value.getTime()) : clock.now(); if (Number.isNaN(result.getTime())) throw new ValidationError("Lifecycle timestamp must be valid"); return result; }
function requireId(value: string, field: string): string { if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`${field} must be a non-empty identifier`); return value.trim(); }
function validatePolicy(policy: { readonly rawMessageRetentionDays: number; readonly contentLogRetentionDays: number; readonly personaDecayDays: number }): void { for (const [name, value] of Object.entries(policy)) if (!Number.isInteger(value) || value <= 0) throw new ValidationError(`${name} must be a positive integer`); }

export interface LifecycleServiceOptions { readonly clock?: Clock; readonly now?: () => Date; readonly policyProvider?: RetentionPolicyProvider; }

export function createDataLifecycleService(repository: LifecycleRepository, options: LifecycleServiceOptions = {}): LifecycleService {
  const clock = options.clock ?? (options.now ? { now: options.now } : systemClock);
  return {
    async unsend(input: UnsendInput) {
      const occurredAt = at(input.occurredAt, clock); const normalized: UnsendInput = { ...input, groupId: requireId(input.groupId, "groupId"), lineMessageId: requireId(input.lineMessageId, "lineMessageId"), occurredAt };
      return repository.unsend(normalized, { groupId: normalized.groupId, actorMemberId: input.actorMemberId, action: "unsend", targetType: "message", targetId: normalized.lineMessageId, occurredAt });
    },
    async forgetMe(input: ForgetInput) {
      const occurredAt = at(input.occurredAt, clock); const normalized: ForgetInput = { ...input, groupId: requireId(input.groupId, "groupId"), memberId: requireId(input.memberId, "memberId"), occurredAt };
      return repository.forgetMe(normalized, { groupId: normalized.groupId, actorMemberId: input.actorMemberId ?? normalized.memberId, action: "forget_me", targetType: "member", targetId: normalized.memberId, occurredAt });
    },
    async sweep(input: RetentionSweepInput) {
      const now = at(input.now, clock);
      const policy = input.policy ?? (input.groupId ? await options.policyProvider?.getRetentionPolicy(input.groupId) : null);
      if (!policy) throw new ValidationError("Retention policy is required for sweep");
      validatePolicy(policy);
      const normalized: RetentionSweepInput = { ...input, now, policy };
      return repository.sweep(normalized, input.groupId ? { groupId: input.groupId, action: "retention_sweep", targetType: "retention", occurredAt: now } : undefined);
    },
  };
}

export const createLifecycleService = createDataLifecycleService;

