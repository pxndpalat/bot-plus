import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createApp } from "../src/app/index.ts";

test("bootstrap app factory creates an Elysia application", () => {
  const app = createApp();

  assert.equal(typeof app.listen, "function");
});
