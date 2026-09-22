import { ValidationError } from "../../shared/index.ts";
import { createRedactor, type RedactionOptions } from "./redaction.ts";
import type { EventCorrelation } from "./events.ts";

export interface AuditEvent {
  readonly event: "audit";
  readonly action: string;
  readonly actorLineUserId: string;
  readonly occurredAt: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly correlationId?: string;
  readonly correlation?: EventCorrelation;
  readonly metadata?: Record<string, unknown>;
}

export interface AuditEventInput extends Omit<AuditEvent, "event" | "occurredAt" | "actorLineUserId"> {
  readonly event?: "audit";
  readonly occurredAt?: string | Date;
  readonly actorLineUserId?: string;
  readonly actor?: { readonly lineUserId: string };
}

export interface AuditEventPort {
  readonly record: (event: AuditEvent) => Promise<void>;
  readonly append: (event: AuditEvent) => Promise<void>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`Audit event ${field} must be a non-empty string`);
  return value;
}

function auditDate(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(requiredString(value, "occurredAt"));
  if (Number.isNaN(date.getTime())) throw new ValidationError("Audit event occurredAt must be a valid date");
  return date.toISOString();
}

export function createAuditEvent(input: AuditEventInput, options: RedactionOptions = {}): AuditEvent {
  const actorLineUserId = input.actorLineUserId ?? input.actor?.lineUserId;
  const redactor = createRedactor(options);
  const metadata = input.metadata === undefined
    ? undefined
    : redactor.redact(input.metadata) as Record<string, unknown>;
  return {
    event: "audit",
    action: requiredString(input.action, "action"),
    actorLineUserId: requiredString(actorLineUserId, "actorLineUserId"),
    occurredAt: auditDate(input.occurredAt),
    targetType: input.targetType === undefined ? undefined : requiredString(input.targetType, "targetType"),
    targetId: input.targetId === undefined ? undefined : requiredString(input.targetId, "targetId"),
    correlationId: input.correlationId === undefined ? undefined : requiredString(input.correlationId, "correlationId"),
    correlation: input.correlation,
    metadata,
  };
}

export function createAuditEventPort(writer: (event: AuditEvent) => Promise<void> | void): AuditEventPort {
  const record = async (event: AuditEvent): Promise<void> => {
    await writer(createAuditEvent(event));
  };
  return { record, append: record };
}

export function createInMemoryAuditEventPort(): AuditEventPort & { readonly events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const record = async (event: AuditEvent): Promise<void> => {
    events.push(createAuditEvent(event));
  };
  return { events, record, append: record };
}
