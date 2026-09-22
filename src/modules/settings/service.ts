import {
  UnauthorizedError,
  ValidationError,
  utcDate,
  type Clock,
  systemClock,
} from "../../shared/index.ts";
import type { RetentionSettingsPort } from "../retention/settings-ports.ts";
import type { SettingsRepository } from "./ports.ts";
import type {
  BudgetDecision,
  BudgetUsageInput,
  GroupMode,
  GroupModeInput,
  GroupSettings,
  GroupSettingsMutation,
  RetentionPolicy,
  SettingsStatusSnapshot,
} from "./types.ts";

const THAI_MODES: Readonly<Record<string, GroupMode>> = Object.freeze({
  สุภาพ: "polite",
  ปกติ: "normal",
  แซวแรง: "teasing",
});

export function parseGroupMode(input: GroupModeInput): GroupMode {
  if (input === "polite" || input === "normal" || input === "teasing") return input;
  const mode = THAI_MODES[input];
  if (mode) return mode;
  throw new ValidationError("Unsupported group mode", { field: "mode" });
}

export function isGroupMuted(settings: Pick<GroupSettings, "muteUntil">, at: Date): boolean {
  return settings.muteUntil !== null && settings.muteUntil.getTime() > at.getTime();
}

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new ValidationError(`${field} must be a non-empty trimmed string`, { field });
  }
  return value;
}

function positiveOrZeroInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, { field });
  }
  return value;
}

function validDate(value: Date, field: string): Date {
  try {
    return utcDate(value);
  } catch {
    throw new ValidationError(`${field} must be a valid date`, { field });
  }
}

export interface SettingsService extends RetentionSettingsPort {
  isAdmin(lineUserId: string): boolean;
  requireAdmin(lineUserId: string): void;
  getGroupSettings(groupId: string): Promise<GroupSettings | null>;
  updateGroupSettings(
    actorLineUserId: string,
    groupId: string,
    mutation: GroupSettingsMutation,
    at?: Date,
  ): Promise<GroupSettings>;
  consumeAiBudget(input: BudgetUsageInput): Promise<BudgetDecision>;
  getStatusSnapshot(groupId: string, at?: Date): Promise<SettingsStatusSnapshot | null>;
}

export interface SettingsServiceOptions {
  readonly adminLineUserIds: readonly string[];
  readonly clock?: Clock;
}

export function createSettingsService(
  repository: SettingsRepository,
  options: SettingsServiceOptions,
): SettingsService {
  const adminIds = new Set(options.adminLineUserIds);
  const clock = options.clock ?? systemClock;

  const service: SettingsService = {
    isAdmin(lineUserId: string): boolean {
      return typeof lineUserId === "string" && adminIds.has(lineUserId);
    },

    requireAdmin(lineUserId: string): void {
      if (!service.isAdmin(lineUserId)) throw new UnauthorizedError("Admin authorization required");
    },

    async getGroupSettings(groupId: string): Promise<GroupSettings | null> {
      return repository.getGroupSettings(requiredId(groupId, "groupId"));
    },

    async updateGroupSettings(
      actorLineUserId: string,
      groupId: string,
      mutation: GroupSettingsMutation,
      at = clock.now(),
    ): Promise<GroupSettings> {
      service.requireAdmin(actorLineUserId);
      const normalizedGroupId = requiredId(groupId, "groupId");
      const occurredAt = validDate(at, "occurredAt");
      const normalized: GroupSettingsMutation = {
        ...(mutation.mode === undefined ? {} : { mode: parseGroupMode(mutation.mode) }),
        ...(mutation.muteUntil === undefined
          ? {}
          : {
              muteUntil:
                mutation.muteUntil === null ? null : validDate(mutation.muteUntil, "muteUntil"),
            }),
        ...(mutation.dailyTokenBudget === undefined
          ? {}
          : {
              dailyTokenBudget: positiveOrZeroInteger(
                mutation.dailyTokenBudget,
                "dailyTokenBudget",
              ),
            }),
        ...(mutation.ambientEnabled === undefined
          ? {}
          : { ambientEnabled: mutation.ambientEnabled }),
        ...(mutation.active === undefined ? {} : { active: mutation.active }),
      };
      if (Object.keys(normalized).length === 0)
        throw new ValidationError("At least one setting must change");

      const metadata: { [key: string]: string | number | boolean | null } = {};
      if (normalized.mode !== undefined) metadata.mode = normalized.mode;
      if (normalized.muteUntil !== undefined) {
        metadata.muteUntil =
          normalized.muteUntil === null ? null : normalized.muteUntil.toISOString();
      }
      if (normalized.dailyTokenBudget !== undefined)
        metadata.dailyTokenBudget = normalized.dailyTokenBudget;
      if (normalized.ambientEnabled !== undefined)
        metadata.ambientEnabled = normalized.ambientEnabled;
      if (normalized.active !== undefined) metadata.active = normalized.active;

      return repository.updateGroupSettings(normalizedGroupId, normalized, {
        action: "group_settings.updated",
        actorLineUserId,
        occurredAt,
        metadata,
      });
    },

    async consumeAiBudget(input: BudgetUsageInput): Promise<BudgetDecision> {
      const groupId = requiredId(input.groupId, "groupId");
      const model = requiredId(input.model, "model");
      const operation = requiredId(input.operation, "operation");
      const inputTokens = positiveOrZeroInteger(input.inputTokens, "inputTokens");
      const outputTokens = positiveOrZeroInteger(input.outputTokens, "outputTokens");
      const occurredAt =
        input.occurredAt === undefined ? clock.now() : validDate(input.occurredAt, "occurredAt");
      return repository.consumeAiBudget({
        ...input,
        groupId,
        model,
        operation,
        inputTokens,
        outputTokens,
        occurredAt,
      });
    },

    async getStatusSnapshot(
      groupId: string,
      at = clock.now(),
    ): Promise<SettingsStatusSnapshot | null> {
      return repository.getStatusSnapshot(requiredId(groupId, "groupId"), validDate(at, "at"));
    },

    async getRetentionPolicy(groupId: string): Promise<RetentionPolicy | null> {
      return repository.getRetentionPolicy(requiredId(groupId, "groupId"));
    },
  };

  return service;
}
