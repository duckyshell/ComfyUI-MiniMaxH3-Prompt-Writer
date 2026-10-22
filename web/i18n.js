import { messages as en } from "./locales/en.js";
import { messages as zhCN } from "./locales/zh-CN.js";

export const LANGUAGE_PREFERENCES = Object.freeze(["auto", "en", "zh-CN"]);
export const LOCALES = Object.freeze(["en", "zh-CN"]);
const DICTIONARIES = { en, "zh-CN": zhCN };
const listeners = new Set();
const warnedMissingKeys = new Set();
let warnedLocaleSetting = false;

let preference = "auto";
let locale = "en";
let rootElement = null;
let hostApp = null;
let navigatorLanguage = "";

export function normalizeLanguagePreference(value) {
  return LANGUAGE_PREFERENCES.includes(value) ? value : "auto";
}

export function resolveLocale(value, { app = null, navigatorLanguage: language = "" } = {}) {
  const normalized = normalizeLanguagePreference(value);
  if (normalized !== "auto") return normalized;
  let comfyLocale = "";
  try {
    comfyLocale = app?.ui?.settings?.getSettingValue?.("Comfy.Locale") || "";
  } catch (error) {
    if (!warnedLocaleSetting) {
      warnedLocaleSetting = true;
      console.warn(`[H3 Writer i18n] Failed to read Comfy.Locale, falling back to navigator language: ${error?.message || error}`);
    }
    comfyLocale = "";
  }
  const source = String(comfyLocale || language || "");
  return source.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function lookupTranslation(targetLocale, key, dictionaries = DICTIONARIES) {
  const primary = dictionaries[targetLocale] || dictionaries.en;
  if (Object.hasOwn(primary, key)) return primary[key];
  if (targetLocale !== "en" && Object.hasOwn(dictionaries.en, key)) return dictionaries.en[key];
  const marker = `${targetLocale}:${key}`;
  if (!warnedMissingKeys.has(marker)) {
    warnedMissingKeys.add(marker);
    console.warn(`[H3 Writer i18n] Missing translation: ${marker}`);
  }
  return key;
}

export function hasTranslation(key, targetLocale = locale) {
  if (Object.hasOwn(DICTIONARIES[targetLocale] || {}, key)) return true;
  return targetLocale !== "en" && Object.hasOwn(DICTIONARIES.en, key);
}

function interpolate(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}

export function t(key, params) {
  return interpolate(lookupTranslation(locale, key), params ?? {});
}

export const msg = (key, params = {}) => ({ key, params });

export function messageText(value) {
  if (value == null) return "";
  if (typeof value === "object" && typeof value.key === "string") return t(value.key, value.params || {});
  return String(value);
}

function activeDocument() {
  return rootElement?.ownerDocument || (typeof document === "undefined" ? null : document);
}

function applyDocumentLocale() {
  const document = activeDocument();
  if (document?.documentElement) document.documentElement.lang = locale;
}

export function configureI18n({ preference: value = "auto", app = null, navigatorLanguage: language = "", root = null } = {}) {
  hostApp = app;
  if (language) navigatorLanguage = language;
  preference = normalizeLanguagePreference(value);
  locale = resolveLocale(preference, { app: hostApp, navigatorLanguage });
  if (root) rootElement = root;
  applyDocumentLocale();
  if (rootElement) translateDom(rootElement);
  return locale;
}

export function getLanguagePreference() {
  return preference;
}

export function getLocale() {
  return locale;
}

export function setLanguagePreference(value) {
  preference = normalizeLanguagePreference(value);
  locale = resolveLocale(preference, { app: hostApp, navigatorLanguage });
  applyDocumentLocale();
  if (rootElement) translateDom(rootElement);
  for (const listener of [...listeners]) {
    try {
      listener(locale);
    } catch (error) {
      console.error("[H3 Writer i18n] Locale listener failed", error);
    }
  }
  return locale;
}

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const TRANSLATABLE_SELECTOR = "[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]";

export function translateDom(root) {
  if (!root?.querySelectorAll) return root;
  const elements = [...root.querySelectorAll(TRANSLATABLE_SELECTOR)];
  if (root.matches?.(TRANSLATABLE_SELECTOR)) elements.unshift(root);
  for (const element of elements) {
    if (element.closest?.("[data-i18n-skip], [data-output], pre[data-seq-reader-text]")) continue;
    const { i18n, i18nTitle, i18nAriaLabel, i18nPlaceholder } = element.dataset;
    if (i18n && !["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
      element.textContent = t(i18n);
    }
    if (i18nTitle) element.setAttribute("title", t(i18nTitle));
    if (i18nAriaLabel) element.setAttribute("aria-label", t(i18nAriaLabel));
    if (i18nPlaceholder && ["INPUT", "TEXTAREA"].includes(element.tagName)) {
      element.setAttribute("placeholder", t(i18nPlaceholder));
    }
  }
  return root;
}

function technicalDetails(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

export function localizedError(error, fallbackKey = "errors.UNKNOWN", params = {}) {
  const code = typeof error?.code === "string" && error.code ? error.code : "";
  const codeKey = code ? `errors.${code}` : "";
  const key = codeKey && hasTranslation(codeKey) ? codeKey : fallbackKey;
  const values = { ...(error?.params || {}), ...params };
  const technical = [error?.message ? String(error.message) : "", technicalDetails(error?.details)]
    .filter(Boolean)
    .join("\n\n");
  return { code, key, message: t(key, values), technical };
}
