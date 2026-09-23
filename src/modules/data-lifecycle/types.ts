export type LifecycleMessageReason = "unsent" | "forgotten" | "retention";

export interface RetentionPolicyInput {
  readonly rawMessageRetentionDays: number;
  readonly contentLogRetentionDays: number;
  readonly personaDecayDays: number;
}

export interface UnsendInput {
  readonly groupId: string;
  readonly lineMessageId: string;
  readonly messageId?: string;
  readonly occurredAt?: Date;
  readonly actorMemberId?: string;
}

export interface ForgetInput {
  readonly groupId: string;
  readonly memberId: string;
  readonly occurredAt?: Date;
  readonly actorMemberId?: string;
}

export interface RetentionSweepInput {
  readonly groupId?: string;
  readonly now?: Date;
  readonly policy?: RetentionPolicyInput;
}

export interface LifecycleResult {
  readonly alreadyApplied: boolean;
  readonly messagesDeleted: number;
  readonly jobsCancelled: number;
  readonly observationsInvalidated: number;
  readonly factsArchived: number;
  readonly contentLogsDeleted: number;
  readonly aliasesDeleted: number;
  readonly tombstoneCreated: boolean;
}

export interface LifecycleService {
  unsend(input: UnsendInput): Promise<LifecycleResult>;
  forgetMe(input: ForgetInput): Promise<LifecycleResult>;
  sweep(input: RetentionSweepInput): Promise<LifecycleResult>;
}

export interface LifecycleAudit {
  readonly groupId: string;
  readonly actorMemberId?: string;
  readonly action: "unsend" | "forget_me" | "retention_sweep";
  readonly targetType: "message" | "member" | "retention";
  readonly targetId?: string;
  readonly occurredAt: Date;
}

