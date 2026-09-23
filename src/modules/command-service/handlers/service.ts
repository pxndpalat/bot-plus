import {
  UnauthorizedError,
  ValidationError,
  noOpTransaction,
  systemClock,
  type Clock,
  type TransactionBoundary,
} from "../../../shared/index.ts";
import type { PersonaFact, PersonaService } from "../../persona-service/index.ts";
import type { SettingsService } from "../../settings/index.ts";
import { createAuditEvent, type AuditEventPort } from "../../telemetry/index.ts";
import type { ParsedCommand } from "../parser/types.ts";
import type {
  CommandAuditPort,
  CommandExecutionContext,
  CommandHandlerResult,
  CommandIdempotencyStore,
  CommandResult,
  CommandTransaction,
  ForgetMemberInput,
  MemberLifecyclePort,
} from "./types.ts";

type RequiredPersona = Pick<PersonaService,
  "getMember" | "getFacts" | "saveObservation" | "resolveFacts" | "addAlias" |
  "setMemoryOptOut" | "setMemoryOptIn">;
type RequiredSettings = Pick<SettingsService,
  "isAdmin" | "requireAdmin" | "updateGroupSettings" | "getStatusSnapshot">;

export interface CommandHandlerDependencies {
  readonly persona: RequiredPersona;
  readonly settings: RequiredSettings;
  readonly lifecycle?: MemberLifecyclePort;
  readonly audit?: CommandAuditPort | AuditEventPort;
  readonly transaction?: CommandTransaction | TransactionBoundary;
  readonly idempotency?: CommandIdempotencyStore;
  readonly clock?: Clock;
}

export interface CommandHandler {
  handle(command: ParsedCommand, context: CommandExecutionContext): Promise<CommandHandlerResult>;
  execute(command: ParsedCommand, context: CommandExecutionContext): Promise<CommandHandlerResult>;
}

function dateOf(value: Date | undefined, clock: Clock): Date {
  const date = value === undefined ? clock.now() : new Date(value.getTime());
  if (Number.isNaN(date.getTime())) throw new ValidationError("Command timestamp must be valid");
  return date;
}

function cloneDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

function cloneFact(fact: PersonaFact): PersonaFact {
  return {
    ...fact,
    firstSeenAt: new Date(fact.firstSeenAt.getTime()),
    lastSeenAt: new Date(fact.lastSeenAt.getTime()),
    expiresOrDecayAt: new Date(fact.expiresOrDecayAt.getTime()),
    archivedAt: cloneDate(fact.archivedAt),
    observationIds: [...fact.observationIds],
  };
}

function safeFacts(facts: readonly PersonaFact[]): readonly PersonaFact[] {
  // Defensive copies prevent a transport from mutating repository-owned values.
  return facts.filter((fact) => fact.active && fact.visibility !== "risky").map(cloneFact);
}

function copyResult(result: CommandResult): CommandResult {
  return {
    ...result,
    message: result.text,
    ...(result.facts ? { facts: safeFacts(result.facts) } : {}),
    ...(result.status
      ? {
          status: {
            ...result.status,
            muteUntil: cloneDate(result.status.muteUntil),
            budget: { ...result.status.budget },
          },
        }
      : {}),
    ...(result.observation
      ? {
          observation: {
            ...result.observation,
            observedAt: new Date(result.observation.observedAt.getTime()),
            invalidatedAt: cloneDate(result.observation.invalidatedAt),
            metadata: { ...result.observation.metadata },
          },
        }
      : {}),
  };
}

function idempotencyKey(command: ParsedCommand, context: CommandExecutionContext): string | undefined {
  if (!context.eventId || context.eventId.trim().length === 0) return undefined;
  return `${context.groupId}\u0000${context.eventId}\u0000${command.command}`;
}

function correctionParts(input: string): { category: PersonaFact["category"]; claim: string } {
  const value = input.trim();
  if (!value) throw new ValidationError("Correction must not be empty");
  const separator = value.indexOf(":");
  if (separator < 0) return { category: "preference", claim: value };
  const category = value.slice(0, separator).trim();
  const claim = value.slice(separator + 1).trim();
  const categories: readonly PersonaFact["category"][] = [
    "food", "hobby", "skill", "work", "travel", "relationship", "habit",
    "preference", "dislike", "nickname",
  ];
  if (!categories.includes(category as PersonaFact["category"]) || !claim) {
    return { category: "preference", claim: value };
  }
  return { category: category as PersonaFact["category"], claim };
}

export function createCommandHandler(dependencies: CommandHandlerDependencies): CommandHandler {
  const clock = dependencies.clock ?? systemClock;
  const transaction = dependencies.transaction ?? noOpTransaction;
  const pending = new Map<string, Promise<CommandResult>>();

  async function writeAudit(input: {
    readonly action: string;
    readonly actorLineUserId: string;
    readonly groupId: string;
    readonly occurredAt: Date;
    readonly eventId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!dependencies.audit) return;
    const event = createAuditEvent({
      action: input.action,
      actorLineUserId: input.actorLineUserId,
      occurredAt: input.occurredAt,
      targetType: "group",
      targetId: input.groupId,
      correlationId: input.eventId,
      metadata: input.metadata,
    });
    await dependencies.audit.record(event);
  }

  async function execute(command: ParsedCommand, context: CommandExecutionContext): Promise<CommandResult> {
    if (!context || typeof context.groupId !== "string" || context.groupId.trim().length === 0) {
      throw new ValidationError("groupId must be a non-empty string");
    }
    const occurredAt = dateOf(context.now, clock);
    const actorLineUserId = String(command.actorUserId);
    const member = await dependencies.persona.getMember(context.groupId, actorLineUserId);
    if (!member) throw new UnauthorizedError("Member is not known in this group");
    const memberId = String(member.id);

    switch (command.command) {
      case "who_am_i": {
        const facts = safeFacts(await dependencies.persona.getFacts({
          groupId: context.groupId,
          subjectMemberId: memberId,
          includeRisky: false,
        }));
        return {
          ok: true, command: command.command, kind: "query",
          text: facts.length === 0 ? "ยังไม่มีข้อมูล persona ของคุณ" : "นี่คือข้อมูล persona ของคุณ",
          message: facts.length === 0 ? "ยังไม่มีข้อมูล persona ของคุณ" : "นี่คือข้อมูล persona ของคุณ",
          facts,
        };
      }

      case "correct_persona": {
        const correction = correctionParts(command.correction);
        const observation = await dependencies.persona.saveObservation({
          groupId: context.groupId,
          subjectMemberId: memberId,
          category: correction.category,
          claim: correction.claim,
          sourceStrength: "self_correction",
          confidence: 1,
          visibility: "public_safe",
          extractedByMemberId: memberId,
          now: occurredAt,
        });
        const facts = safeFacts(await dependencies.persona.resolveFacts(context.groupId, memberId, correction.category, occurredAt));
        await writeAudit({ action: "persona.corrected", actorLineUserId, groupId: context.groupId, occurredAt, eventId: context.eventId, metadata: { category: correction.category } });
        return {
          ok: true, command: command.command, kind: "mutation",
          text: "บันทึกการแก้ไขข้อมูลของคุณแล้ว",
          message: "บันทึกการแก้ไขข้อมูลของคุณแล้ว",
          ...(observation ? { observation } : {}), facts,
        };
      }

      case "set_alias": {
        const alias = await dependencies.persona.addAlias({ groupId: context.groupId, memberId, alias: command.alias, isPrimary: true });
        await writeAudit({ action: "persona.alias_set", actorLineUserId, groupId: context.groupId, occurredAt, eventId: context.eventId, metadata: { alias: alias.alias } });
        return { ok: true, command: command.command, kind: "mutation", text: `จะเรียกคุณว่า ${alias.alias}`, message: `จะเรียกคุณว่า ${alias.alias}`, alias: alias.alias };
      }

      case "memory_opt_out":
        await dependencies.persona.setMemoryOptOut(context.groupId, memberId);
        await writeAudit({ action: "persona.memory_opted_out", actorLineUserId, groupId: context.groupId, occurredAt, eventId: context.eventId });
        return { ok: true, command: command.command, kind: "mutation", text: "หยุดสร้างความจำระยะยาวของคุณแล้ว ข้อมูลในหน้าต่างสนทนาปัจจุบันยังใช้ได้", message: "หยุดสร้างความจำระยะยาวของคุณแล้ว ข้อมูลในหน้าต่างสนทนาปัจจุบันยังใช้ได้", optedOut: true };

      case "memory_opt_in":
        await dependencies.persona.setMemoryOptIn(context.groupId, memberId);
        await writeAudit({ action: "persona.memory_opted_in", actorLineUserId, groupId: context.groupId, occurredAt, eventId: context.eventId });
        return { ok: true, command: command.command, kind: "mutation", text: "เปิดการสร้างความจำระยะยาวของคุณแล้ว", message: "เปิดการสร้างความจำระยะยาวของคุณแล้ว", optedOut: false };

      case "forget_me": {
        if (!dependencies.lifecycle?.forgetMember && !dependencies.lifecycle?.forgetMe) throw new ValidationError("Forget lifecycle port is not configured");
        const input: ForgetMemberInput = { groupId: context.groupId, memberId, actorLineUserId, occurredAt, idempotencyKey: context.eventId };
        if (dependencies.lifecycle.forgetMember) await dependencies.lifecycle.forgetMember(input);
        else await dependencies.lifecycle.forgetMe!({ groupId: input.groupId, memberId: input.memberId, actorMemberId: input.memberId, occurredAt: input.occurredAt });
        await writeAudit({ action: "persona.forgotten", actorLineUserId, groupId: context.groupId, occurredAt, eventId: context.eventId });
        return { ok: true, command: command.command, kind: "mutation", text: "ลบข้อมูลปัจจุบันของคุณแล้ว และระบบจะเรียนรู้ใหม่จากข้อความถัดไปได้ หากยังไม่ได้หยุดวิเคราะห์", message: "ลบข้อมูลปัจจุบันของคุณแล้ว และระบบจะเรียนรู้ใหม่จากข้อความถัดไปได้ หากยังไม่ได้หยุดวิเคราะห์" };
      }

      case "mute": {
        dependencies.settings.requireAdmin(actorLineUserId);
        const muteUntil = new Date(occurredAt.getTime() + command.durationMs);
        const settings = await dependencies.settings.updateGroupSettings(actorLineUserId, context.groupId, { muteUntil }, occurredAt);
        return { ok: true, command: command.command, kind: "mutation", text: `ปิดเสียงกลุ่มชั่วคราวถึง ${settings.muteUntil?.toISOString() ?? ""}`, message: `ปิดเสียงกลุ่มชั่วคราวถึง ${settings.muteUntil?.toISOString() ?? ""}` };
      }

      case "set_mode": {
        dependencies.settings.requireAdmin(actorLineUserId);
        const settings = await dependencies.settings.updateGroupSettings(actorLineUserId, context.groupId, { mode: command.mode }, occurredAt);
        return { ok: true, command: command.command, kind: "mutation", text: `ตั้งโหมดเป็น ${settings.mode} แล้ว`, message: `ตั้งโหมดเป็น ${settings.mode} แล้ว` };
      }

      case "status": {
        dependencies.settings.requireAdmin(actorLineUserId);
        const status = await dependencies.settings.getStatusSnapshot(context.groupId, occurredAt);
        if (!status) throw new ValidationError("Group settings are not available");
        return { ok: true, command: command.command, kind: "status", text: "สถานะระบบพร้อมใช้งาน", message: "สถานะระบบพร้อมใช้งาน", status: { ...status, muteUntil: cloneDate(status.muteUntil), budget: { ...status.budget } } };
      }
    }
  }

  async function handle(command: ParsedCommand, context: CommandExecutionContext): Promise<CommandHandlerResult> {
    const key = idempotencyKey(command, context);
    if (key) {
      if (dependencies.idempotency) {
        const existing = await dependencies.idempotency.get(key);
        if (existing) return copyResult(existing);
      }
      const prior = pending.get(key);
      if (prior) return copyResult(await prior);
      const work = transaction.run(async () => {
        const result = await execute(command, context);
        if (dependencies.idempotency) await dependencies.idempotency.set(key, copyResult(result));
        return result;
      });
      pending.set(key, work);
      try { return copyResult(await work); } finally { pending.delete(key); }
    }
    return copyResult(await transaction.run(() => execute(command, context)));
  }

  return { handle, execute: handle };
}

export const createCommandService = createCommandHandler;
export const createCommandHandlers = createCommandHandler;
