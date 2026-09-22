import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  assertAtMostOnce,
  assertNoSecrets,
  buildTextWebhookEvent,
  createAtMostOnceRecorder,
  createFakeClock,
  createFakeIdGenerator,
  createFakeRandom,
  createFakeOpenAI,
  createFakeLineClient,
} from "../support/index.ts";

test("fake clock and random source are deterministic", async () => {
  const clock = createFakeClock(Date.UTC(2026, 0, 1));
  let elapsed = false;
  const wait = clock.sleep(5000).then(() => {
    elapsed = true;
  });
  clock.advance(4999);
  assert.equal(elapsed, false);
  clock.advance(1);
  await wait;
  assert.equal(clock.now().toISOString(), "2026-01-01T00:00:05.000Z");

  const random = createFakeRandom({ values: [0.1, 0.9], repeatLast: false });
  assert.equal(random.integer(10, 19), 11);
  assert.equal(random.integer(10, 19), 19);
  assert.equal(random.calls(), 2);
});

test("fake transports and builders record calls without network access", async () => {
  const line = createFakeLineClient();
  await line.reply("reply-token", [{ type: "text", text: "hello" }], "response-001");
  assert.equal(line.replies.length, 1);
  assert.equal(line.replies[0]?.claimKey, "response-001");

  const openai = createFakeOpenAI({ output: { decision: "ignore" } });
  const result = await openai.responses({ input: "hello", model: "test-model" });
  assert.deepEqual(result.output, { decision: "ignore" });
  assert.equal(openai.calls.length, 1);

  const event = buildTextWebhookEvent("hello");
  assert.equal(event.message?.text, "hello");
  assert.equal(event.source.type, "group");
});

test("idempotency and log redaction assertions catch unsafe behavior", () => {
  const ids = createFakeIdGenerator("response");
  const recorder = createAtMostOnceRecorder();
  recorder.run(ids.next(), () => "sent");
  recorder.run("response-duplicate", () => "sent");
  recorder.run("response-duplicate", () => "must-not-run");
  assertAtMostOnce(recorder.records);
  assertNoSecrets(
    [{ message: "redacted", authorization: "[REDACTED]" }],
    ["channel-secret", "access-token"],
  );
  assert.equal(recorder.records.length, 2);
});
