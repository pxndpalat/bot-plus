import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  TELEMETRY_EVENT_NAMES,
  createAuditEvent,
  createInMemoryAuditEventPort,
  createLogger,
  createTelemetryEvent,
  redactValue,
  validateTelemetryEvent,
} from "./index.ts";

test("redaction handles nested metadata, arrays, circular values, and errors", () => {
  const cause = new Error("upstream key=oa-secret");
  const error = new Error("request failed oa-secret", { cause });
  const value: Record<string, unknown> = {
    channelSecret: "channel-secret",
    nested: { headers: { Authorization: "Bearer oa-secret", Cookie: "session" } },
    content: "private message",
    error,
    items: [{ accessToken: "access-token" }],
  };
  value.self = value;

  const redacted = redactValue(value, {
    additionalValues: ["channel-secret", "oa-secret", "access-token", "session"],
  });
  const json = JSON.stringify(redacted);
  assert.equal(json.includes("channel-secret"), false);
  assert.equal(json.includes("oa-secret"), false);
  assert.equal(json.includes("access-token"), false);
  assert.equal(json.includes("session"), false);
  assert.equal(json.includes("private message"), false);
  assert.match(json, /REDACTED/);
  assert.match(json, /Circular/);
});

test("structured logger adds correlation and keeps content debug on its own sink", () => {
  const operational: Record<string, unknown>[] = [];
  const content: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: "debug",
    additionalValues: ["secret-value"],
    correlation: { webhookId: "evt-1", correlationId: "trace-1" },
    sink: (record) => operational.push(record),
    contentSink: (record) => content.push(record),
  });
  logger.info("received", { nested: { authorization: "secret-value" }, text: "do not log" });
  logger.debugContent({ content: "safe debug text secret-value", metadata: { userId: "U-1" } });

  assert.equal(operational.length, 1);
  assert.equal(operational[0]?.correlationId, "trace-1");
  assert.equal(JSON.stringify(operational[0]).includes("do not log"), false);
  assert.equal(content.length, 1);
  assert.equal(content[0]?.channel, "content_debug");
  assert.equal(content[0]?.retentionDays, 7);
  assert.equal(JSON.stringify(content[0]).includes("secret-value"), false);
});

test("telemetry events validate required fields and reject unknown event names", () => {
  const event = createTelemetryEvent({
    event: TELEMETRY_EVENT_NAMES.latency,
    operation: "line.reply",
    durationMs: 42,
    correlationId: "trace-1",
  });
  assert.equal(event.event, "latency");
  assert.equal(event.durationMs, 42);
  assert.throws(() => validateTelemetryEvent({ event: "latency", operation: "" }), /operation/);
  assert.throws(() => validateTelemetryEvent({ event: "unknown" }), /Unknown telemetry event/);
  assert.throws(() => validateTelemetryEvent({ event: "duplicate_response", idempotencyKey: "key", duplicate: false }), /duplicate=true/);
});

test("audit event requires a LINE userId actor and is exposed through a port", async () => {
  const event = createAuditEvent({ action: "persona.forget", actorLineUserId: "U-actor", targetType: "member", targetId: "M-1" });
  assert.equal(event.actorLineUserId, "U-actor");
  assert.throws(() => createAuditEvent({ action: "persona.forget", actorLineUserId: "" }), /actorLineUserId/);

  const port = createInMemoryAuditEventPort();
  await port.record(event);
  assert.equal(port.events.length, 1);
  assert.equal(port.events[0]?.actorLineUserId, "U-actor");
});
