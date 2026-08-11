import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/compat.js", import.meta.url), "utf8");
const encoded = Buffer.from(source).toString("base64");
const { createSessionId, moveOntoTarget, replaceEventListener } = await import(`data:text/javascript;base64,${encoded}`);

test("createSessionId falls back to a valid UUID v4", () => {
  const fallbackCrypto = {
    getRandomValues(bytes) {
      bytes.set([...Array(bytes.length).keys()]);
      return bytes;
    },
  };

  const value = createSessionId(fallbackCrypto);
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("createSessionId preserves native randomUUID when available", () => {
  const expected = "11111111-2222-4333-8444-555555555555";
  assert.equal(createSessionId({ randomUUID: () => expected }), expected);
});

test("replacing a persistent media listener prevents duplicate dispatch", () => {
  const media = new EventTarget();
  const calls = [];
  replaceEventListener(media, "drop", "media", () => calls.push("old-mode"));
  replaceEventListener(media, "drop", "media", () => calls.push("current-mode"));

  media.dispatchEvent(new Event("drop"));
  assert.deepEqual(calls, ["current-mode"]);
});

test("dropping on another media card moves in either direction without an edge hit", () => {
  const assets = [{ id: "picture" }, { id: "video" }, { id: "audio" }];
  assert.deepEqual(moveOntoTarget(assets, "picture", "video").map((asset) => asset.id), ["video", "picture", "audio"]);
  assert.deepEqual(moveOntoTarget(assets, "audio", "video").map((asset) => asset.id), ["picture", "audio", "video"]);
});
