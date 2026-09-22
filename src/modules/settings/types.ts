export type GroupMode = "polite" | "normal" | "teasing";
export type GroupModeInput = GroupMode | "สุภาพ" | "ปกติ" | "แซวแรง";
export type BudgetPath = "ambient" | "direct" | "command";

export type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonSafeValue[]
  | { readonly [key: string]: JsonSafeValue };

export interface GroupSettings {
  readonly groupId: string;
  readonly active: boolean;
  readonly mode: GroupMode;
  readonly muteUntil: Date | null;
  readonly ambientEnabled: boolean;
  readonly ambientMinDelaySeconds: number;
  readonly ambientMaxDelaySeconds: number;
  readonly ambientCooldownSeconds: number;
  readonly dailyTokenBudget: number;
  readonly rawMessageRetentionDays: number;
  readonly contentLogRetentionDays: number;
  readonly personaDecayDays: number;
  readonly updatedAt: Date;
}

export interface GroupSettingsMutation {
  readonly mode?: GroupModeInput;
  readonly muteUntil?: Date | null;
  readonly dailyTokenBudget?: number;
  readonly ambientEnabled?: boolean;
  readonly active?: boolean;
}

export interface BudgetUsageInput {
  readonly groupId: string;
  readonly path: BudgetPath;
  readonly model: string;
  readonly operation: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly occurredAt?: Date;
  readonly requestId?: string;
}

export type BudgetBlockReason = "inactive_group" | "daily_budget_exhausted";

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly recorded: boolean;
  readonly reason?: BudgetBlockReason;
  readonly budgetDay: string;
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly remainingTokens: number;
}

export interface BudgetSnapshot {
  readonly budgetDay: string;
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly remainingTokens: number;
}

export interface SettingsStatusSnapshot {
  readonly groupId: string;
  readonly databaseReady: boolean;
  readonly migrationVersion: string | null;
  readonly active: boolean;
  readonly mode: GroupMode;
  readonly muted: boolean;
  readonly muteUntil: Date | null;
  readonly budget: BudgetSnapshot;
}

export interface RetentionPolicy {
  readonly rawMessageRetentionDays: number;
  readonly contentLogRetentionDays: number;
  readonly personaDecayDays: number;
}

export interface SettingsAuditInput {
  readonly action: string;
  readonly actorLineUserId: string;
  readonly occurredAt: Date;
  readonly metadata?: { readonly [key: string]: JsonSafeValue };
}
