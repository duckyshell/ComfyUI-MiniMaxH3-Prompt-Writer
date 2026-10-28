import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { readApiResponse } from "../web/api/response.js";

const source = await readFile(new URL("../web/api/h3studio.js", import.meta.url), "utf8");

function transport(fetchApi) {
  const context = vm.createContext({ api: { fetchApi }, readApiResponse });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  return vm.runInContext("({ generate, refine, cancel, getStatus, probeApiProvider })", context);
}

test("Generate and Refine opt out of ComfyUI's response-header deadline", async () => {
  const calls = [];
  const api = transport(async (route, options) => {
    calls.push({ route, options });
    return Response.json({ prompt: "finished" });
  });
  for (const action of ["generate", "refine"]) {
    const payload = { session_id: "test", model_id: "gguf::test", instruction: "shorter" };
    assert.deepEqual(await api[action](payload), { prompt: "finished" });
    const { route, options } = calls.at(-1);
    assert.equal(route, `/h3studio/${action}`);
    assert.equal(options.timeoutMs, null);
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), payload);
  }
});

test("status, probes and cancellation retain the default timeout during generation", async () => {
  let finish;
  const api = transport((route, options) => {
    if (route === "/h3studio/generate") {
      return new Promise((resolve) => { finish = resolve; });
    }
    assert.equal(options?.timeoutMs, undefined, route);
    return Promise.resolve(Response.json({ ok: true }));
  });
  const pending = api.generate({});
  for (const action of ["getStatus", "probeApiProvider", "cancel"]) {
    assert.deepEqual(await api[action](), { ok: true });
  }
  finish(Response.json({ error: { code: "CANCELLED", message: "Cancelled" } }, { status: 409 }));
  await assert.rejects(pending, { code: "CANCELLED", message: "Cancelled" });
});
