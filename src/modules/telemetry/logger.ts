import { randomUUID } from "node:crypto";
import pino from "pino";
import { createRedactor, type RedactionOptions, type Redactor } from "./redaction.ts";
import { validateTelemetryEvent, type EventCorrelation, type TelemetryEvent } from "./events.ts";

export type CorrelationKind = "webhook" | "job" | "decision" | "response";

export interface CorrelationIds extends EventCorrelation {
  readonly correlationId?: string;
}

export interface ContentDebugEvent {
  readonly event?: "content_debug";
  readonly occurredAt?: string | Date;
  readonly correlationId?: string;
  readonly correlation?: EventCorrelation;
  readonly content: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly retentionDays?: 7;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly [key: string]: unknown;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions extends RedactionOptions {
  readonly level?: LogLevel;
  readonly bindings?: Record<string, unknown>;
  readonly correlation?: CorrelationIds;
  readonly sink?: LogSink;
  readonly contentSink?: LogSink;
}

export interface StructuredLogger {
  readonly child: (bindings: Record<string, unknown>) => StructuredLogger;
  readonly withCorrelation: (correlation: CorrelationIds) => StructuredLogger;
  readonly correlation: CorrelationIds;
  readonly debug: (message: string, fields?: Record<string, unknown> | Error) => void;
  readonly info: (message: string, fields?: Record<string, unknown> | Error) => void;
  readonly warn: (message: string, fields?: Record<string, unknown> | Error) => void;
  readonly error: (message: string, fields?: Record<string, unknown> | Error) => void;
  readonly emit: (event: TelemetryEvent) => void;
  readonly metric: (event: TelemetryEvent) => void;
  readonly debugContent: (event: ContentDebugEvent) => void;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function nowIso(): string {
  return new Date().toISOString();
}

function asFields(fields: Record<string, unknown> | Error | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  if (fields instanceof Error) return { error: fields };
  return fields;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function newCorrelationId(kind?: CorrelationKind): string {
  return `${kind ? `${kind}-` : ""}${randomUUID()}`;
}

export function createCorrelationIds(input: (Partial<Record<CorrelationKind, string>> & Partial<CorrelationIds>) = {}): CorrelationIds {
  const webhookId = input.webhook ?? input.webhookId;
  const jobId = input.job ?? input.jobId;
  const decisionId = input.decision ?? input.decisionId;
  const responseId = input.response ?? input.responseId;
  const ids: CorrelationIds = {
    correlationId: input.correlationId ?? webhookId ?? jobId ?? decisionId ?? responseId ?? newCorrelationId(),
    webhookId,
    jobId,
    decisionId,
    responseId,
  };
  return ids;
}

export const createCorrelationContext = createCorrelationIds;

function createPino(level: LogLevel): ReturnType<typeof pino> {
  return pino({ level, base: undefined, timestamp: false });
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  const level = options.level ?? "info";
  const redactor: Redactor = createRedactor(options);
  const pinoLogger = createPino(level);
  const bindings = options.bindings ?? {};
  const correlation = options.correlation ?? {};

  const write = (logLevel: LogLevel, message: string, fields: Record<string, unknown>): void => {
    if (LOG_LEVEL_ORDER[logLevel] < LOG_LEVEL_ORDER[level]) return;
    const record = {
      level: logLevel,
      message: redactor.redactText(message),
      timestamp: nowIso(),
      ...asRecord(redactor.redact(bindings)),
      ...asRecord(redactor.redact(correlation)),
      ...asRecord(redactor.redact(fields)),
    } as LogRecord;
    if (options.sink) {
      options.sink(record);
      return;
    }
    const pinoFields = { ...record } as Record<string, unknown>;
    delete pinoFields.level;
    delete pinoFields.message;
    delete pinoFields.timestamp;
    pinoLogger[logLevel](pinoFields, record.message);
  };

  const logger: StructuredLogger = {
    correlation,
    child(childBindings) {
      return createLogger({
        ...options,
        bindings: { ...bindings, ...childBindings },
        correlation,
      });
    },
    withCorrelation(nextCorrelation) {
      return createLogger({
        ...options,
        bindings,
        correlation: { ...correlation, ...nextCorrelation },
      });
    },
    debug(message, fields) {
      write("debug", message, asFields(fields));
    },
    info(message, fields) {
      write("info", message, asFields(fields));
    },
    warn(message, fields) {
      write("warn", message, asFields(fields));
    },
    error(message, fields) {
      write("error", message, asFields(fields));
    },
    emit(event) {
      const validated = validateTelemetryEvent(event);
      write("info", validated.event, validated as unknown as Record<string, unknown>);
    },
    metric(event) {
      logger.emit(event);
    },
    debugContent(event) {
      const contentRecord = {
        level: "debug" as const,
        message: "content_debug",
        timestamp: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt ?? nowIso(),
        channel: "content_debug",
        event: "content_debug" as const,
        retentionDays: 7 as const,
        ...asRecord(redactor.redact({
          ...event,
          event: "content_debug",
          retentionDays: 7,
        }, { redactContent: false })),
      } as LogRecord;
      if (options.contentSink) {
        options.contentSink(contentRecord);
      } else if (options.sink) {
        options.sink(contentRecord);
      } else {
        const pinoFields = { ...contentRecord } as Record<string, unknown>;
        delete pinoFields.level;
        delete pinoFields.message;
        delete pinoFields.timestamp;
        pinoLogger.debug(pinoFields, contentRecord.message);
      }
    },
  };
  return logger;
}

export const createStructuredLogger = createLogger;
