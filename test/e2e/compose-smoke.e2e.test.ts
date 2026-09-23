import { createHmac } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "bun:test";

const baseUrl = process.env.E2E_BASE_URL?.replace(/\/$/u, "");

const composeSmoke = baseUrl ? test : test.skip;

composeSmoke("MFB-022 Compose smoke: live/ready and signed webhook", async () => {
  const live = await fetch(`${baseUrl}/health/live`);
  assert.equal(live.status, 200);
  const ready = await fetch(`${baseUrl}/health/ready`);
  assert.equal(ready.status, 200);

  const payload = JSON.stringify({ events: [] });
  const invalid = await fetch(`${baseUrl}/webhooks/line`, { method: "POST", headers: { "x-line-signature": "invalid" }, body: payload });
  assert.equal(invalid.status, 401);

  const secret = process.env.E2E_CHANNEL_SECRET;
  if (!secret) return;
  const signature = createHmac("sha256", secret).update(payload).digest("base64");
  const valid = await fetch(`${baseUrl}/webhooks/line`, { method: "POST", headers: { "x-line-signature": signature }, body: payload });
  assert.equal(valid.status, 200);
});
