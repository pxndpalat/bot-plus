import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createApp } from "../../src/app/index.ts";

test("bootstrap app can be started and stopped", () => {
  const app = createApp().listen({ hostname: "127.0.0.1", port: 0 });

  assert.ok(app.server);
  app.stop();
});
