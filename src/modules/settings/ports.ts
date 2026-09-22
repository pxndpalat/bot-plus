import type {
  BudgetDecision,
  BudgetSnapshot,
  BudgetUsageInput,
  GroupSettings,
  GroupSettingsMutation,
  RetentionPolicy,
  SettingsAuditInput,
  SettingsStatusSnapshot,
} from "./types.ts";

export interface SettingsRepository {
  getGroupSettings(groupId: string): Promise<GroupSettings | null>;
  updateGroupSettings(
    groupId: string,
    mutation: GroupSettingsMutation,
    audit: SettingsAuditInput,
  ): Promise<GroupSettings>;
  consumeAiBudget(input: BudgetUsageInput): Promise<BudgetDecision>;
  getBudgetSnapshot(groupId: string, at: Date): Promise<BudgetSnapshot | null>;
  getStatusSnapshot(groupId: string, at: Date): Promise<SettingsStatusSnapshot | null>;
  getRetentionPolicy(groupId: string): Promise<RetentionPolicy | null>;
}
