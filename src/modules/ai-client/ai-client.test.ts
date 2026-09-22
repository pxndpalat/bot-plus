import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  AiClientError,
  createAiClient,
  createFakeAiResponsesTransport,
  type JsonSchema,
  type UsageAccountingEvent,
} from "./index.ts";
import { createLogger } from "../telemetry/index.ts";

const schema: JsonSchema = {
  type: "object",
  properties: { answer: { type: "string", minLength: 1 } },
  required: ["answer"],
  additionalProperties: false,
};

const request = {
  task: "test_answer",
  prompt: { question: "hello" },
  schema,
};

test("structured client returns valid JSON and sends strict schema without tools", async () => {
  const transport = createFakeAiResponsesTransport([{ outputText: '{"answer":"hi"}', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }]);
  const client = createAiClient({ transport });
  const result = await client.structured(request);

  assert.deepEqual(result.value, { answer: "hi" });
  assert.equal(result.billedUsage.status, "known");
  assert.equal(result.attempts, 1);
  assert.equal(transport.calls[0]?.model, "gpt-5-nano");
  assert.equal(transport.calls[0]?.text.format.strict, true);
  assert.equal(transport.calls[0]?.text.format.type, "json_schema");
  assert.equal("tools" in (transport.calls[0] ?? {}), false);
});

test("invalid JSON and invalid schema retry exactly once", async () => {
  const transport = createFakeAiResponsesTransport([
    { outputText: "not-json" },
    { outputText: '{"answer":"recovered"}' },
  ]);
  const client = createAiClient({ transport });
  const result = await client.structured(request);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.value, { answer: "recovered" });

  const invalidSchemaTransport = createFakeAiResponsesTransport([
    { outputText: '{"answer":42}' },
    { outputText: '{"answer":"valid"}' },
  ]);
  const invalidSchemaClient = createAiClient({ transport: invalidSchemaTransport });
  const recovered = await invalidSchemaClient.structured(request);
  assert.deepEqual(recovered.value, { answer: "valid" });
  assert.equal(invalidSchemaTransport.calls.length, 2);
});

test("timeout retries once, reports unknown billed usage, and exhausted retry is typed", async () => {
  const usage: UsageAccountingEvent[] = [];
  const transport = createFakeAiResponsesTransport([{ outputText: '{"answer":"after-timeout"}' }]);
  transport.enqueueError(new Error("request timed out"));
  const client = createAiClient({ transport, usagePort: { record: (event) => { usage.push(event); } } });
  const result = await client.structured(request);
  assert.equal(result.attempts, 2);
  assert.equal(result.billedUsage.status, "unknown");
  assert.equal(usage.length, 2);
  assert.equal(usage[0]?.outcome, "timeout");
  assert.equal(usage[1]?.outcome, "success");

  const exhaustedTransport = createFakeAiResponsesTransport();
  exhaustedTransport.enqueueError(new Error("ETIMEDOUT"));
  exhaustedTransport.enqueueError(new Error("ETIMEDOUT"));
  const exhaustedClient = createAiClient({ transport: exhaustedTransport });
  await assert.rejects(
    () => exhaustedClient.structured(request),
    (error: unknown) => {
      assert.ok(error instanceof AiClientError);
      assert.equal(error.code, "timeout");
      assert.equal(error.attempts, 2);
      assert.equal(error.billedUsage.status, "unknown");
      return true;
    },
  );
  assert.equal(exhaustedTransport.calls.length, 2);
});

test("custom app validator is applied after JSON schema validation", async () => {
  const transport = createFakeAiResponsesTransport([{ outputText: '{"answer":"ok"}' }]);
  const client = createAiClient({ transport });
  const result = await client.structured({
    ...request,
    validate: (value: unknown) => {
      const object = value as { answer: string };
      return object.answer.toUpperCase();
    },
  });
  assert.equal(result.value, "OK");
});

test("prompt policy boundaries, output limit, and operational log privacy are enforced", async () => {
  const transport = createFakeAiResponsesTransport([{ outputText: '{"answer":"ok"}' }]);
  const logs: Record<string, unknown>[] = [];
  const client = createAiClient({
    transport,
    policy: "fixed policy",
    logger: createLogger({ level: "debug", sink: (record) => logs.push(record) }),
  });
  await client.structured({ ...request, prompt: { tools: ["never"] } }).catch((error: unknown) => {
    assert.ok(error instanceof AiClientError);
    assert.equal(error.code, "request_invalid");
  });
  assert.equal(transport.calls.length, 0);

  const safeClient = createAiClient({ transport, maxOutputBytes: 4 });
  await assert.rejects(() => safeClient.structured(request), (error: unknown) => {
    assert.ok(error instanceof AiClientError);
    assert.equal(error.code, "output_too_large");
    return true;
  });
  assert.equal(transport.calls.length, 1);

  const privateTransport = createFakeAiResponsesTransport([{ outputText: '{"answer":"ok"}' }]);
  const privateClient = createAiClient({
    transport: privateTransport,
    logger: createLogger({ sink: (record) => logs.push(record) }),
  });
  await privateClient.structured({ ...request, prompt: "OPENAI_API_KEY=private-key-and-user-content" });
  const logText = JSON.stringify(logs);
  assert.equal(logText.includes("private-key-and-user-content"), false);
  assert.equal(logText.includes("OPENAI_API_KEY"), false);
});
