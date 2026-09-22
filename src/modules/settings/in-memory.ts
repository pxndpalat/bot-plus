import { bangkokBudgetDay, startOfBangkokBudgetDay } from "../../shared/index.ts";
import type { SettingsRepository } from "./ports.ts";
import type {
  BudgetDecision,
  BudgetSnapshot,
  BudgetUsageInput,
  GroupSettings,
  RetentionPolicy,
  SettingsAuditInput,
  SettingsStatusSnapshot,
} from "./types.ts";

const DAY_MS = 86_400_000;

export interface InMemoryGroupSeed {
  readonly groupId: string;
  readonly active?: boolean;
  readonly mode?: GroupSettings["mode"];
  readonly muteUntil?: Date | null;
  readonly dailyTokenBudget?: number;
  readonly ambientEnabled?: boolean;
  readonly rawMessageRetentionDays?: number;
  readonly contentLogRetentionDays?: number;
  readonly personaDecayDays?: number;
  readonly updatedAt?: Date;
}

interface UsageRecord extends BudgetUsageInput {
  readonly totalTokens: number;
}

export interface InMemorySettingsRepository extends SettingsRepository {
  readonly audits: readonly SettingsAuditInput[];
  readonly usageEvents: readonly UsageRecord[];
  failNextMutationAudit: boolean;
  seedGroup(seed: InMemoryGroupSeed): void;
}

function copyDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

function defaults(seed: InMemoryGroupSeed): GroupSettings {
  return {
    groupId: seed.groupId,
    active: seed.active ?? true,
    mode: seed.mode ?? "normal",
    muteUntil: copyDate(seed.muteUntil ?? null),
    ambientEnabled: seed.ambientEnabled ?? true,
    ambientMinDelaySeconds: 15,
    ambientMaxDelaySeconds: 30,
    ambientCooldownSeconds: 180,
    dailyTokenBudget: seed.dailyTokenBudget ?? 100_000,
    rawMessageRetentionDays: seed.rawMessageRetentionDays ?? 30,
    contentLogRetentionDays: seed.contentLogRetentionDays ?? 7,
    personaDecayDays: seed.personaDecayDays ?? 180,
    updatedAt: new Date(seed.updatedAt?.getTime() ?? 0),
  };
}

function cloneSettings(settings: GroupSettings): GroupSettings {
  return {
    ...settings,
    muteUntil: copyDate(settings.muteUntil),
    updatedAt: new Date(settings.updatedAt.getTime()),
  };
}

function budgetWindow(at: Date): {
  readonly day: string;
  readonly start: Date;
  readonly end: Date;
} {
  const start = startOfBangkokBudgetDay(at);
  return { day: bangkokBudgetDay(at), start, end: new Date(start.getTime() + DAY_MS) };
}

function snapshotFor(settings: GroupSettings, usageEvents: readonly UsageRecord[], at: Date) {
  const window = budgetWindow(at);
  const usedTokens = usageEvents
    .filter((event) => event.groupId === settings.groupId)
    .filter((event) => event.occurredAt !== undefined)
    .filter((event) => {
      const timestamp = event.occurredAt as Date;
      return timestamp >= window.start && timestamp < window.end;
    })
    .reduce((sum, event) => sum + event.totalTokens, 0);
  return {
    budgetDay: window.day,
    usedTokens,
    limitTokens: settings.dailyTokenBudget,
    remainingTokens: Math.max(settings.dailyTokenBudget - usedTokens, 0),
  };
}

export function createInMemorySettingsRepository(
  initialGroups: readonly InMemoryGroupSeed[] = [],
): InMemorySettingsRepository {
  const groups = new Map<string, GroupSettings>();
  const audits: SettingsAuditInput[] = [];
  const usageEvents: UsageRecord[] = [];
  for (const seed of initialGroups) groups.set(seed.groupId, defaults(seed));

  const repository: InMemorySettingsRepository = {
    audits,
    usageEvents,
    failNextMutationAudit: false,

    seedGroup(seed): void {
      groups.set(seed.groupId, defaults(seed));
    },

    async getGroupSettings(groupId): Promise<GroupSettings | null> {
      const settings = groups.get(groupId);
      return settings === undefined ? null : cloneSettings(settings);
    },

    async updateGroupSettings(groupId, mutation, audit): Promise<GroupSettings> {
      const current = groups.get(groupId);
      if (current === undefined) throw new Error(`Unknown group: ${groupId}`);
      if (repository.failNextMutationAudit) {
        repository.failNextMutationAudit = false;
        throw new Error("audit write failed");
      }
      const updated: GroupSettings = {
        ...current,
        ...(mutation.mode === undefined ? {} : { mode: mutation.mode as GroupSettings["mode"] }),
        ...(mutation.muteUntil === undefined ? {} : { muteUntil: copyDate(mutation.muteUntil) }),
        ...(mutation.dailyTokenBudget === undefined
          ? {}
          : { dailyTokenBudget: mutation.dailyTokenBudget }),
        ...(mutation.ambientEnabled === undefined
          ? {}
          : { ambientEnabled: mutation.ambientEnabled }),
        ...(mutation.active === undefined ? {} : { active: mutation.active }),
        updatedAt: new Date(audit.occurredAt.getTime()),
      };
      groups.set(groupId, updated);
      audits.push({
        ...audit,
        occurredAt: new Date(audit.occurredAt.getTime()),
        metadata: audit.metadata && { ...audit.metadata },
      });
      return cloneSettings(updated);
    },

    async consumeAiBudget(input): Promise<BudgetDecision> {
      const settings = groups.get(input.groupId);
      const at = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt.getTime());
      const totalTokens = input.inputTokens + input.outputTokens;
      if (settings === undefined || !settings.active) {
        return {
          allowed: false,
          recorded: false,
          reason: "inactive_group",
          budgetDay: bangkokBudgetDay(at),
          usedTokens: 0,
          limitTokens: settings?.dailyTokenBudget ?? 0,
          remainingTokens: 0,
        };
      }
      const before = snapshotFor(settings, usageEvents, at);
      if (input.path === "ambient" && before.usedTokens + totalTokens > before.limitTokens) {
        return { ...before, allowed: false, recorded: false, reason: "daily_budget_exhausted" };
      }
      usageEvents.push({ ...input, occurredAt: at, totalTokens });
      const after = snapshotFor(settings, usageEvents, at);
      return { ...after, allowed: true, recorded: true };
    },

    async getBudgetSnapshot(groupId, at): Promise<BudgetSnapshot | null> {
      const settings = groups.get(groupId);
      return settings === undefined ? null : snapshotFor(settings, usageEvents, at);
    },

    async getStatusSnapshot(groupId, at): Promise<SettingsStatusSnapshot | null> {
      const settings = groups.get(groupId);
      if (settings === undefined) return null;
      const budget = snapshotFor(settings, usageEvents, at);
      return {
        groupId,
        databaseReady: true,
        migrationVersion: "in-memory",
        active: settings.active,
        mode: settings.mode,
        muted: settings.muteUntil !== null && settings.muteUntil.getTime() > at.getTime(),
        muteUntil: copyDate(settings.muteUntil),
        budget,
      };
    },

    async getRetentionPolicy(groupId): Promise<RetentionPolicy | null> {
      const settings = groups.get(groupId);
      if (settings === undefined) return null;
      return {
        rawMessageRetentionDays: settings.rawMessageRetentionDays,
        contentLogRetentionDays: settings.contentLogRetentionDays,
        personaDecayDays: settings.personaDecayDays,
      };
    },
  };

  return repository;
}
