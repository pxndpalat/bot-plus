import { createHmac } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { ambientCandidateDueAt, createApplication, createScheduledRetentionRunner, createTrackedReplyPort } from "./index.ts";

const secret = "fixture-channel-secret";
const body = JSON.stringify({ events: [{
  type: "message",
  webhookEventId: "event-1",
  timestamp: 1_735_689_600_000,
  source: { type: "group", groupId: "C-group", userId: "U-member" },
  replyToken: "reply-token",
  message: { type: "text", id: "message-1", text: "hello" },
}] });

function signature(value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64");
}

test("application rejects invalid signatures before parsing or persistence", async () => {
    let calls = 0;
    const application = createApplication({ channelSecret: secret, webhook: { handleVerifiedEvent: async () => { calls += 1; return { duplicate: false, webhookEventId: "event-1", jobs: [] }; } } });
    const response = await application.app.handle(new Request("http://localhost/webhooks/line", { method: "POST", headers: { "x-line-signature": "bad" }, body: "not-json" }));
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
});

test("application verifies raw bytes and acknowledges valid and duplicate events", async () => {
    const seen: string[] = [];
    const application = createApplication({ channelSecret: secret, webhook: { handleVerifiedEvent: async (event) => { seen.push(String(event.webhookEventId)); return { duplicate: seen.length > 1, webhookEventId: String(event.webhookEventId), jobs: [] }; } } });
    const request = () => new Request("http://localhost/webhooks/line", { method: "POST", headers: { "x-line-signature": signature(body) }, body });
    assert.equal((await application.app.handle(request())).status, 200);
    assert.equal((await application.app.handle(request())).status, 200);
    assert.deepEqual(seen, ["event-1", "event-1"]);
});

test("application maps persistence failure to non-2xx", async () => {
    const application = createApplication({ channelSecret: secret, webhook: { handleVerifiedEvent: async () => { throw new Error("database down"); } } });
    const response = await application.app.handle(new Request("http://localhost/webhooks/line", { method: "POST", headers: { "x-line-signature": signature(body) }, body }));
    assert.equal(response.status, 503);
});

test("application exposes live and readiness without secrets", async () => {
    const application = createApplication({ readiness: async () => ({ ready: true, database: true, migrationVersion: "001_initial" }) });
    assert.equal((await application.app.handle(new Request("http://localhost/health/live"))).status, 200);
    const response = await application.app.handle(new Request("http://localhost/health/ready"));
    assert.equal(response.status, 200);
    const value = await response.json() as Record<string, unknown>;
    assert.deepEqual(value, { status: "ok", database: true, migrationVersion: "001_initial" });
    assert.equal(JSON.stringify(value).includes(secret), false);
});

test("application stop drains runner and closes resources exactly once", async () => {
    const calls: string[] = [];
    const application = createApplication({
      jobRunner: { start: () => { calls.push("start"); }, runOnce: async () => 0, stop: async () => { calls.push("runner-stop"); return { drained: true, inFlight: 0 }; }, get running() { return true; } },
      close: () => { calls.push("close"); },
    });
    await application.start({ port: 31_337 });
    await application.stop();
    await application.stop();
    assert.deepEqual(calls, ["start", "runner-stop", "close"]);
    assert.equal(application.state, "stopped");
});

test("ambient durable due time is stable and stays inside the configured delay", () => {
    const receivedAt = new Date("2026-01-01T00:00:00.000Z");
    const first = ambientCandidateDueAt(receivedAt, "event-1:ambient_candidate", 15_000, 30_000);
    const restarted = ambientCandidateDueAt(receivedAt, "event-1:ambient_candidate", 15_000, 30_000);
    assert.equal(first.toISOString(), restarted.toISOString());
    assert.ok(first.getTime() >= receivedAt.getTime() + 15_000);
    assert.ok(first.getTime() <= receivedAt.getTime() + 30_000);
});

test("production runner schedules retention and drains its underlying worker", async () => {
    const calls: string[] = [];
    const base = {
      start: () => { calls.push("worker-start"); },
      runOnce: async () => 0,
      stop: async () => { calls.push("worker-stop"); return { drained: true, inFlight: 0 }; },
      get running() { return true; },
    };
    const runner = createScheduledRetentionRunner(base, {
      sweep: async () => {
        calls.push("retention-sweep");
        return { alreadyApplied: false, messagesDeleted: 0, jobsCancelled: 0, observationsInvalidated: 0, factsArchived: 0, contentLogsDeleted: 0, aliasesDeleted: 0, tombstoneCreated: false };
      },
    }, { rawMessageRetentionDays: 30, contentLogRetentionDays: 7, personaDecayDays: 180 });
    runner.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runner.stop();
    assert.deepEqual(calls, ["worker-start", "retention-sweep", "worker-stop"]);
});

test("tracked ambient reply persists sent and uncertain transport outcomes", async () => {
    const states: string[] = [];
    const claims = {
      async markSent() { states.push("sent"); return {} as never; },
      async markUnknown() { states.push("unknown"); return {} as never; },
    };
    const success = createTrackedReplyPort({ reply: async () => undefined }, claims);
    await success.reply({ replyToken: "token", messages: [{ type: "text", text: "ok" }], claimProof: { idempotencyKey: "key", responseId: "response-1" } });
    const failure = createTrackedReplyPort({ reply: async () => { throw new Error("timeout"); } }, claims);
    await assert.rejects(() => failure.reply({ replyToken: "token", messages: [{ type: "text", text: "ok" }], claimProof: { idempotencyKey: "key-2", responseId: "response-2" } }));
    assert.deepEqual(states, ["sent", "unknown"]);
});
