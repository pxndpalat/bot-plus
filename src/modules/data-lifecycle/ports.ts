import type { ForgetInput, LifecycleAudit, LifecycleResult, RetentionPolicyInput, RetentionSweepInput, UnsendInput } from "./types.ts";

export interface LifecycleRepository {
  unsend(input: UnsendInput, audit: LifecycleAudit): Promise<LifecycleResult>;
  forgetMe(input: ForgetInput, audit: LifecycleAudit): Promise<LifecycleResult>;
  sweep(input: RetentionSweepInput, audit?: LifecycleAudit): Promise<LifecycleResult>;
}

export interface RetentionPolicyProvider {
  getRetentionPolicy(groupId: string): Promise<RetentionPolicyInput | null>;
}

