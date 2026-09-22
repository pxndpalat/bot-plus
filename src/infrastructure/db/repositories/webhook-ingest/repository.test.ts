import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { canonicalMediaMetadata } from "./repository.ts";

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

