import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

import {
  LANGUAGE_PREFERENCES,
  configureI18n,
  getLanguagePreference,
  getLocale,
  hasTranslation,
  localizedError,
  lookupTranslation,
  messageText,
  msg,
  normalizeLanguagePreference,
  onLocaleChange,
  resolveLocale,
  setLanguagePreference,
  t,
  translateDom,
} from "../web/i18n.js";
import { messages as en } from "../web/locales/en.js";
import { messages as zhCN } from "../web/locales/zh-CN.js";
import { networkError, readApiResponse } from "../web/api/response.js";
import { createStudioState, loadUserPreferences, saveUserPreferences } from "../web/studio_state.js";
import { writeToastContent } from "../web/toast.js";
import { writeStatusContent } from "../web/status.js";

const window = new Window();
const root = window.document.createElement("div");
window.document.body.append(root);

test("dictionaries have identical non-empty key sets", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  for (const dictionary of [en, zhCN]) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.trim().length > 0, key);
    }
  }
});

test("language preferences accept only the three supported values", () => {
  assert.deepEqual([...LANGUAGE_PREFERENCES], ["auto", "en", "zh-CN"]);
  assert.equal(normalizeLanguagePreference("zh-CN"), "zh-CN");
  assert.equal(normalizeLanguagePreference("EN"), "auto");
  assert.equal(normalizeLanguagePreference(null), "auto");
  assert.equal(normalizeLanguagePreference("fr"), "auto");
});

test("auto resolves ComfyUI locale first, then navigator language", () => {
  const comfy = (locale) => ({ ui: { settings: { getSettingValue: () => locale } } });
  assert.equal(resolveLocale("auto", { app: comfy("zh-CN"), navigatorLanguage: "en-US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { app: comfy("zh-TW"), navigatorLanguage: "en-US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { app: comfy("fr-FR"), navigatorLanguage: "zh-CN" }), "en");
  assert.equal(resolveLocale("auto", { app: comfy(""), navigatorLanguage: "zh-Hans" }), "zh-CN");
  assert.equal(resolveLocale("auto", { navigatorLanguage: "de-DE" }), "en");
  const throwing = { ui: { settings: { getSettingValue: () => { throw new Error("not available"); } } } };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(resolveLocale("auto", { app: throwing, navigatorLanguage: "zh-Hant" }), "zh-CN");
    assert.equal(resolveLocale("auto", { app: throwing, navigatorLanguage: "zh-Hant" }), "zh-CN");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.filter((line) => line.includes("Comfy.Locale")).length, 1);
  assert.equal(resolveLocale("en", { app: comfy("zh-CN") }), "en");
  assert.equal(resolveLocale("zh-CN", { app: comfy("en-US") }), "zh-CN");
});

test("t interpolates parameters and falls back predictably", () => {
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  assert.equal(t("meta.prompt_length", { characters: "12", words: "3" }), "12 characters · 3 words");
  configureI18n({ preference: "zh-CN", root });
  assert.equal(t("meta.prompt_length", { characters: "12", words: "3" }), "12 字符 · 3 词");
  assert.equal(t("missing.key"), "missing.key");
  assert.equal(
    lookupTranslation("zh-CN", "only.en", { en: { "only.en": "English only" }, "zh-CN": {} }),
    "English only",
  );
  assert.equal(lookupTranslation("zh-CN", "missing.key", { en: {}, "zh-CN": {} }), "missing.key");
  assert.equal(hasTranslation("common.cancel"), true);
  assert.equal(hasTranslation("missing.key"), false);
  assert.equal(t("common.cancel", null), "取消");
  assert.equal(messageText(msg("common.cancel")), "取消");
  assert.equal(messageText("raw backend text"), "raw backend text");
  assert.equal(messageText(null), "");
});

test("setLanguagePreference updates state, document lang, and notifies once", () => {
  let calls = 0;
  let notifiedLocale = "";
  const unsubscribe = onLocaleChange((locale) => { calls += 1; notifiedLocale = locale; });
  configureI18n({ preference: "en", root, navigatorLanguage: "en-US" });
  assert.equal(setLanguagePreference("zh-CN"), "zh-CN");
  assert.equal(getLocale(), "zh-CN");
  assert.equal(getLanguagePreference(), "zh-CN");
  assert.equal(window.document.documentElement.lang, "zh-CN");
  assert.equal(calls, 1);
  assert.equal(notifiedLocale, "zh-CN");
  unsubscribe();
  setLanguagePreference("en");
  assert.equal(calls, 1);
});

test("translateDom translates text and attributes but never values or raw output", () => {
  configureI18n({ preference: "zh-CN", root });
  root.innerHTML = `
    <button data-i18n="common.cancel" title="old" data-i18n-title="common.close"
      aria-label="old" data-i18n-aria-label="common.language"></button>
    <input data-i18n="common.cancel" data-i18n-placeholder="common.language" value="keep me">
    <textarea data-i18n="common.close" data-i18n-placeholder="common.language">keep text</textarea>
    <select data-i18n="common.close"><option>fixed</option></select>
    <span data-i18n-skip data-i18n="common.cancel">skip me</span>
    <span data-output data-i18n="common.cancel">generated output</span>
    <pre data-seq-reader-text data-i18n="common.cancel">sequence output</pre>
  `;
  translateDom(root);
  const button = root.querySelector("button");
  assert.equal(button.textContent, "取消");
  assert.equal(button.title, "关闭");
  assert.equal(button.getAttribute("aria-label"), "语言");
  const input = root.querySelector("input");
  assert.equal(input.value, "keep me");
  assert.equal(input.getAttribute("placeholder"), "语言");
  assert.equal(input.textContent, "");
  const textarea = root.querySelector("textarea");
  assert.equal(textarea.value, "keep text");
  const select = root.querySelector("select");
  assert.equal(select.textContent.trim(), "fixed");
  assert.equal(root.querySelector("[data-i18n-skip]").textContent, "skip me");
  assert.equal(root.querySelector("[data-output]").textContent, "generated output");
  assert.equal(root.querySelector("[data-seq-reader-text]").textContent, "sequence output");
});

test("localizedError maps codes and preserves English technical details", () => {
  configureI18n({ preference: "zh-CN", root });
  const known = localizedError(Object.assign(new Error("Backend said busy"), {
    code: "GENERATION_BUSY",
    details: { queue: 1 },
  }));
  assert.equal(known.message, zhCN["errors.GENERATION_BUSY"]);
  assert.match(known.technical, /Backend said busy/);
  assert.match(known.technical, /"queue": 1/);
  const unknown = localizedError(Object.assign(new Error("Model exploded"), { code: "SOMETHING_NEW" }));
  assert.equal(unknown.message, zhCN["errors.UNKNOWN"]);
  assert.match(unknown.technical, /Model exploded/);
  const noCode = localizedError(new Error("plain failure"));
  assert.equal(noCode.message, zhCN["errors.UNKNOWN"]);
  assert.equal(noCode.technical, "plain failure");
});

test("language preference round-trips through user preferences", () => {
  const data = new Map([["h3ps-preferences-v1", JSON.stringify({ version: 1, language: "zh-CN" })]]);
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  assert.equal(loadUserPreferences(storage).language, "zh-CN");
  const state = createStudioState({ sessionId: "test", storage });
  assert.equal(state.language, "zh-CN");
  assert.equal(state.languageChosen, true);
  saveUserPreferences(storage, { ...state, language: "en" });
  assert.equal(JSON.parse(data.get("h3ps-preferences-v1")).language, "en");
  data.set("h3ps-preferences-v1", JSON.stringify({ version: 1, language: "fr" }));
  assert.equal(loadUserPreferences(storage).language, undefined);
  data.set("h3ps-preferences-v1", JSON.stringify({ version: 1 }));
  assert.equal(loadUserPreferences(storage).language, undefined);
});

test("legacy users keep auto behavior without writing language until they switch", () => {
  const data = new Map([["h3ps-preferences-v1", JSON.stringify({ version: 1, theme: "light" })]]);
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  const state = createStudioState({ sessionId: "legacy", storage });
  assert.equal(state.language, "auto");
  assert.equal(state.languageChosen, false);
  saveUserPreferences(storage, { ...state, theme: "dark" });
  assert.equal(Object.hasOwn(JSON.parse(data.get("h3ps-preferences-v1")), "language"), false);
  saveUserPreferences(storage, { ...state, language: "zh-CN", languageChosen: true });
  assert.equal(JSON.parse(data.get("h3ps-preferences-v1")).language, "zh-CN");
});

test("toast and status descriptors re-render in the active locale", () => {
  const toast = window.document.createElement("div");
  toast.innerHTML = `<strong data-toast-title></strong><span data-toast-message></span>
    <button data-toast-action hidden></button><details data-toast-details hidden><summary>Technical details</summary><pre></pre></details>`;
  const status = window.document.createElement("div");
  status.innerHTML = `<strong></strong><span data-status-detail></span>`;
  const snapshot = {
    title: msg("common.notice"),
    message: msg("meta.prompt_length", { characters: "1", words: "2" }),
    details: "Backend detail",
    action: { label: msg("common.retry"), onClick() {} },
  };
  configureI18n({ preference: "en", root });
  writeToastContent(toast, snapshot);
  assert.equal(toast.querySelector("[data-toast-title]").textContent, "Notice");
  assert.equal(toast.querySelector("[data-toast-message]").textContent, "1 characters · 2 words");
  assert.equal(toast.querySelector("[data-toast-details] pre").textContent, "Backend detail");
  assert.equal(toast.querySelector("[data-toast-action]").textContent, "Retry");

  configureI18n({ preference: "zh-CN", root });
  writeToastContent(toast, snapshot);
  assert.equal(toast.querySelector("[data-toast-title]").textContent, "提示");
  assert.equal(toast.querySelector("[data-toast-message]").textContent, "1 字符 · 2 词");
  assert.equal(toast.querySelector("[data-toast-action]").textContent, "重试");

  writeStatusContent(status, { label: msg("status.generating"), detail: msg("common.cancel"), dots: 2 });
  assert.equal(status.querySelector("strong").textContent, "正在生成..");
  assert.equal(status.querySelector("[data-status-detail]").textContent, "取消");
});

test("network failures map to stable error codes", async () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const timeoutError = networkError(timeout);
  assert.equal(timeoutError.code, "REQUEST_TIMEOUT");
  assert.equal(timeoutError.message, "aborted");
  assert.equal(timeoutError.cause, timeout);
  assert.equal(networkError(new Error("offline")).code, "NETWORK_ERROR");
  const failed = { ok: false, status: 502, text: async () => "<html>bad gateway</html>" };
  await assert.rejects(readApiResponse(failed), (error) => error.code === "REQUEST_FAILED");
  const invalid = { ok: true, status: 200, text: async () => "not json" };
  await assert.rejects(readApiResponse(invalid), (error) => error.code === "INVALID_RESPONSE");
  const brokenBody = { ok: true, status: 200, text: async () => { throw new Error("body reset"); } };
  await assert.rejects(readApiResponse(brokenBody), (error) =>
    error.code === "NETWORK_ERROR" && error.cause?.message === "body reset");
});
