import { Kysely, sql } from "kysely";
import { bangkokBudgetDay, startOfBangkokBudgetDay } from "../../../../shared/index.ts";
import { getMigrationStatus } from "../../index.ts";
import type { Database } from "../../types.ts";
import type { SettingsRepository } from "../../../../modules/settings/ports.ts";
import type {
  BudgetDecision,
  BudgetSnapshot,
  BudgetUsageInput,
  GroupSettings,
  GroupSettingsMutation,
  RetentionPolicy,
  SettingsAuditInput,
  SettingsStatusSnapshot,
} from "../../../../modules/settings/types.ts";

interface SettingsRow {
  group_id: string;
  group_left_at: Date | null;
  mode: GroupSettings["mode"] | null;
  muted_until: Date | null;
  ambient_enabled: boolean | null;
  ambient_min_delay_seconds: number | null;
  ambient_max_delay_seconds: number | null;
  ambient_cooldown_seconds: number | null;
  daily_token_budget: number | null;
  raw_message_retention_days: number | null;
  content_log_retention_days: number | null;
  persona_decay_days: number | null;
  settings_updated_at: Date | null;
  group_updated_at: Date;
}

const SETTINGS_DEFAULTS = {
  mode: "normal" as const,
  ambient_enabled: true,
  ambient_min_delay_seconds: 15,
  ambient_max_delay_seconds: 30,
  ambient_cooldown_seconds: 180,
  daily_token_budget: 100_000,
  raw_message_retention_days: 30,
  content_log_retention_days: 7,
  persona_decay_days: 180,
};

function copyDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

function settingsFromRow(row: SettingsRow): GroupSettings {
  return {
    groupId: row.group_id,
    active: row.group_left_at === null,
    mode: row.mode ?? SETTINGS_DEFAULTS.mode,
    muteUntil: copyDate(row.muted_until),
    ambientEnabled: row.ambient_enabled ?? SETTINGS_DEFAULTS.ambient_enabled,
    ambientMinDelaySeconds:
      row.ambient_min_delay_seconds ?? SETTINGS_DEFAULTS.ambient_min_delay_seconds,
    ambientMaxDelaySeconds:
      row.ambient_max_delay_seconds ?? SETTINGS_DEFAULTS.ambient_max_delay_seconds,
    ambientCooldownSeconds:
      row.ambient_cooldown_seconds ?? SETTINGS_DEFAULTS.ambient_cooldown_seconds,
    dailyTokenBudget: row.daily_token_budget ?? SETTINGS_DEFAULTS.daily_token_budget,
    rawMessageRetentionDays:
      row.raw_message_retention_days ?? SETTINGS_DEFAULTS.raw_message_retention_days,
    contentLogRetentionDays:
      row.content_log_retention_days ?? SETTINGS_DEFAULTS.content_log_retention_days,
    personaDecayDays: row.persona_decay_days ?? SETTINGS_DEFAULTS.persona_decay_days,
    updatedAt: new Date((row.settings_updated_at ?? row.group_updated_at).getTime()),
  };
}

function budgetSnapshot(
  budgetDay: string,
  usedTokens: number,
  limitTokens: number,
): BudgetSnapshot {
  return {
    budgetDay,
    usedTokens,
    limitTokens,
    remainingTokens: Math.max(limitTokens - usedTokens, 0),
  };
}

export class KyselySettingsRepository implements SettingsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  private async readSettings(
    db: Kysely<Database>,
    groupId: string,
  ): Promise<SettingsRow | undefined> {
    return db
      .selectFrom("groups")
      .leftJoin("group_settings", "group_settings.group_id", "groups.id")
      .select([
        "groups.id as group_id",
        "groups.left_at as group_left_at",
        "groups.updated_at as group_updated_at",
        "group_settings.mode as mode",
        "group_settings.muted_until as muted_until",
        "group_settings.ambient_enabled as ambient_enabled",
        "group_settings.ambient_min_delay_seconds as ambient_min_delay_seconds",
        "group_settings.ambient_max_delay_seconds as ambient_max_delay_seconds",
        "group_settings.ambient_cooldown_seconds as ambient_cooldown_seconds",
        "group_settings.daily_token_budget as daily_token_budget",
        "group_settings.raw_message_retention_days as raw_message_retention_days",
        "group_settings.content_log_retention_days as content_log_retention_days",
        "group_settings.persona_decay_days as persona_decay_days",
        "group_settings.updated_at as settings_updated_at",
      ])
      .where("groups.id", "=", groupId)
      .executeTakeFirst();
  }

  private async ensureSettings(db: Kysely<Database>, groupId: string): Promise<void> {
    const values = {
      group_id: groupId,
      mode: SETTINGS_DEFAULTS.mode,
      muted_until: null,
      ambient_enabled: SETTINGS_DEFAULTS.ambient_enabled,
      ambient_min_delay_seconds: SETTINGS_DEFAULTS.ambient_min_delay_seconds,
      ambient_max_delay_seconds: SETTINGS_DEFAULTS.ambient_max_delay_seconds,
      ambient_cooldown_seconds: SETTINGS_DEFAULTS.ambient_cooldown_seconds,
      daily_token_budget: SETTINGS_DEFAULTS.daily_token_budget,
      raw_message_retention_days: SETTINGS_DEFAULTS.raw_message_retention_days,
      content_log_retention_days: SETTINGS_DEFAULTS.content_log_retention_days,
      persona_decay_days: SETTINGS_DEFAULTS.persona_decay_days,
    };
    await db
      .insertInto("group_settings")
      .values(values)
      .onConflict((conflict) => conflict.column("group_id").doNothing())
      .execute();
  }

  private async readBudget(
    db: Kysely<Database>,
    groupId: string,
    at: Date,
    limitTokens: number,
  ): Promise<BudgetSnapshot> {
    const start = startOfBangkokBudgetDay(at);
    const end = new Date(start.getTime() + 86_400_000);
    const row = await db
      .selectFrom("ai_usage_events")
      .select(sql<number>`COALESCE(SUM(total_tokens), 0)::double precision`.as("used_tokens"))
      .where("group_id", "=", groupId)
      .where("occurred_at", ">=", start)
      .where("occurred_at", "<", end)
      .executeTakeFirst();
    return budgetSnapshot(bangkokBudgetDay(at), Number(row?.used_tokens ?? 0), limitTokens);
  }

  async getGroupSettings(groupId: string): Promise<GroupSettings | null> {
    const row = await this.readSettings(this.db, groupId);
    return row === undefined ? null : settingsFromRow(row);
  }

  async updateGroupSettings(
    groupId: string,
    mutation: GroupSettingsMutation,
    audit: SettingsAuditInput,
  ): Promise<GroupSettings> {
    return this.db.transaction().execute(async (trx) => {
      const group = await trx
        .selectFrom("groups")
        .select("id")
        .where("id", "=", groupId)
        .forUpdate()
        .executeTakeFirst();
      if (group === undefined) throw new Error(`Unknown group: ${groupId}`);
      await this.ensureSettings(trx, groupId);

      const values: Record<string, unknown> = { updated_at: audit.occurredAt };
      if (mutation.mode !== undefined) values.mode = mutation.mode;
      if (mutation.muteUntil !== undefined) values.muted_until = mutation.muteUntil;
      if (mutation.dailyTokenBudget !== undefined)
        values.daily_token_budget = mutation.dailyTokenBudget;
      if (mutation.ambientEnabled !== undefined) values.ambient_enabled = mutation.ambientEnabled;
      await trx
        .updateTable("group_settings")
        .set(values as never)
        .where("group_id", "=", groupId)
        .execute();

      if (mutation.active !== undefined) {
        await trx
          .updateTable("groups")
          .set({ left_at: mutation.active ? null : audit.occurredAt, updated_at: audit.occurredAt })
          .where("id", "=", groupId)
          .execute();
      }

      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          group_id: groupId,
          actor_member_id: null,
          action: audit.action,
          target_type: "group_settings",
          target_id: groupId,
          metadata: (audit.metadata ?? {}) as never,
          created_at: audit.occurredAt,
        })
        .execute();

      const updated = await this.readSettings(trx, groupId);
      if (updated === undefined) throw new Error(`Settings disappeared for group: ${groupId}`);
      return settingsFromRow(updated);
    });
  }

  async consumeAiBudget(input: BudgetUsageInput): Promise<BudgetDecision> {
    return this.db.transaction().execute(async (trx) => {
      const at = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt.getTime());
      const group = await trx
        .selectFrom("groups")
        .select(["id", "left_at"])
        .where("id", "=", input.groupId)
        .forUpdate()
        .executeTakeFirst();
      const settingsRow =
        group === undefined ? undefined : await this.readSettings(trx, input.groupId);
      const settings = settingsRow === undefined ? undefined : settingsFromRow(settingsRow);
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

      const before = await this.readBudget(trx, input.groupId, at, settings.dailyTokenBudget);
      const totalTokens = input.inputTokens + input.outputTokens;
      if (input.path === "ambient" && before.usedTokens + totalTokens > before.limitTokens) {
        return { ...before, allowed: false, recorded: false, reason: "daily_budget_exhausted" };
      }

      await trx
        .insertInto("ai_usage_events")
        .values({
          id: crypto.randomUUID(),
          group_id: input.groupId,
          decision_id: null,
          operation: input.operation,
          model: input.model,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
          total_tokens: totalTokens,
          occurred_at: at,
          request_id: input.requestId ?? null,
          metadata: { path: input.path },
        })
        .execute();
      const after = await this.readBudget(trx, input.groupId, at, settings.dailyTokenBudget);
      return { ...after, allowed: true, recorded: true };
    });
  }

  async getBudgetSnapshot(groupId: string, at: Date): Promise<BudgetSnapshot | null> {
    const row = await this.readSettings(this.db, groupId);
    if (row === undefined) return null;
    const settings = settingsFromRow(row);
    return this.readBudget(this.db, groupId, at, settings.dailyTokenBudget);
  }

  async getStatusSnapshot(groupId: string, at: Date): Promise<SettingsStatusSnapshot | null> {
    const row = await this.readSettings(this.db, groupId);
    if (row === undefined) return null;
    const settings = settingsFromRow(row);
    const [migration, budget] = await Promise.all([
      getMigrationStatus(this.db),
      this.readBudget(this.db, groupId, at, settings.dailyTokenBudget),
    ]);
    return {
      groupId,
      databaseReady: migration.ready,
      migrationVersion: migration.ready ? migration.latest : null,
      active: settings.active,
      mode: settings.mode,
      muted: settings.muteUntil !== null && settings.muteUntil.getTime() > at.getTime(),
      muteUntil: copyDate(settings.muteUntil),
      budget,
    };
  }

  async getRetentionPolicy(groupId: string): Promise<RetentionPolicy | null> {
    const settings = await this.getGroupSettings(groupId);
    if (settings === null) return null;
    return {
      rawMessageRetentionDays: settings.rawMessageRetentionDays,
      contentLogRetentionDays: settings.contentLogRetentionDays,
      personaDecayDays: settings.personaDecayDays,
    };
  }
}

export function createKyselySettingsRepository(db: Kysely<Database>): SettingsRepository {
  return new KyselySettingsRepository(db);
}
