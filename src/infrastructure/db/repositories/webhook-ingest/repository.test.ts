import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { canonicalMediaMetadata, persistedMessageMetadata } from "./repository.ts";

test("canonical media metadata unwraps provider envelope once without double wrapping", () => {
  assert.deepEqual(
    canonicalMediaMetadata({ unknownMetadata: { provider: true } }),
    { provider: true },
  );
  assert.deepEqual(
    canonicalMediaMetadata({ unknownMetadata: { unknownMetadata: { provider: true } } }),
    { provider: true },
  );
});

test("sticker metadata remains canonical and keeps provider fields", () => {
  assert.deepEqual(
    canonicalMediaMetadata({ packageId: "1", stickerId: "2", stickerResourceType: "STATIC" }),
    { packageId: "1", stickerId: "2", stickerResourceType: "STATIC" },
  );
  assert.deepEqual(
    canonicalMediaMetadata({ unknownMetadata: { provider: true }, packageId: "1" }),
    { provider: true, packageId: "1" },
  );
});

test("text metadata keeps mention addressing for durable direct and command jobs", () => {
  assert.deepEqual(
    persistedMessageMetadata({
      type: "text",
      id: "message-1" as never,
      text: "@bot status",
      mentions: [{ index: 0, length: 4, isSelf: true }],
      metadata: { provider: true },
    }),
    { provider: true, mentions: [{ index: 0, length: 4, isSelf: true }] },
  );
});

