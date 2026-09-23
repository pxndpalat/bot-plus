import type { ParsedCommand } from "../parser/types.ts";
import type { PersonaFact, PersonaObservation } from "../../persona-service/index.ts";
import type { SettingsStatusSnapshot } from "../../settings/index.ts";
import type { AuditEvent } from "../../telemetry/index.ts";

/** The data needed by a command handler in addition to the parsed intent. */
export interface CommandExecutionContext {
  readonly groupId: string;
  /** Webhook/event id. Replays with the same id are returned without mutation. */
  readonly eventId?: string;
  readonly now?: Date;
}

export interface ForgetMemberInput {
  readonly groupId: string;
  readonly memberId: string;
  readonly actorLineUserId: string;
  readonly occurredAt: Date;
  readonly idempotencyKey?: string;
}

/** Implemented by the data-lifecycle module (MFB-019). */
export interface MemberLifecyclePort {
  /** Preferred command-facing shape. */
  forgetMember?(input: ForgetMemberInput): Promise<void>;
  /** Compatibility shape exposed by the data-lifecycle public API. */
  forgetMe?(input: { readonly groupId: string; readonly memberId: string; readonly actorMemberId?: string; readonly occurredAt: Date }): Promise<unknown>;
}

/** A narrow audit port keeps handlers independent from the persistence owner. */
export interface CommandAuditPort {
  record(event: AuditEvent): Promise<void>;
  append?(event: AuditEvent): Promise<void>;
}

export interface CommandTransaction {
  run<T>(work: () => Promise<T> | T): Promise<T>;
}

export interface CommandIdempotencyStore {
  get(key: string): Promise<CommandResult | undefined>;
  set(key: string, result: CommandResult): Promise<void>;
}

export interface CommandResult {
  readonly ok: true;
  readonly command: ParsedCommand["command"];
  readonly kind: "query" | "mutation" | "status";
  /** Safe, user-facing copy. It never contains credentials or an admin allowlist. */
  readonly text: string;
  /** Alias useful to transport adapters that call a reply a message. */
  readonly message: string;
  readonly facts?: readonly PersonaFact[];
  readonly observation?: PersonaObservation;
  readonly status?: SettingsStatusSnapshot;
  readonly optedOut?: boolean;
  readonly alias?: string;
}

export type CommandHandlerResult = CommandResult;
