import { configureI18n, localizedError, t, translateDom } from "./i18n.js";
import {
  CHAT_HISTORY_STORAGE_KEY,
  conversationTitle,
  deleteChatConversation,
  loadChatHistory,
  sanitizeConversationMessages,
  saveChatConversation,
} from "./chat_history.js";
import {
  EXTERNAL_SERVER_STORAGE_KEY,
  USER_PREFERENCES_STORAGE_KEY,
  loadExternalServerConfig,
  loadUserPreferences,
} from "./studio_state.js";
import { renderMarkdown } from "./markdown.js";

const embeddedHost = window.parent !== window ? window.parent : null;

// This page runs in an iframe with its own window. ComfyUI's /scripts/app.js and
// /scripts/api.js are shims over window.comfyAPI, which only exists in the top
// ComfyUI document, so importing them here aborts the module. Borrow the host API
// when embedded and fall back to fetch for a standalone page.
function readHostApi() {
  try {
    const host = embeddedHost?.comfyAPI?.api?.api;
    if (host?.fetchApi) return host;
  } catch (error) {
    console.warn(`[H3 Writer chat] could not read the host ComfyUI API: ${error?.message || error}`);
  }
  return null;
}

function readHostApp() {
  try {
    return embeddedHost?.comfyAPI?.app?.app || null;
  } catch (error) {
    console.warn(`[H3 Writer chat] could not read the host ComfyUI app: ${error?.message || error}`);
    return null;
  }
}

const hostApi = readHostApi();
const api = hostApi || {
  fetchApi(route, options) {
    return fetch(new URL(route, window.location.origin), options);
  },
};
const comfyApp = readHostApp();

const CHAT_ENDPOINT = "/h3studio/chat";
const CANCEL_ENDPOINT = "/h3studio/chat/cancel";
const PROBE_ENDPOINT = "/h3studio/external-server/probe";
const UNLOAD_ENDPOINT = "/h3studio/unload";
const PARAMETER_DEFAULTS = { temperature: "0.8", topP: "0.95", topK: "40", maxTokens: "", seed: "" };
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_VIDEOS_PER_MESSAGE = 1;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 10;
const MAX_IMAGE_EDGE = 1568;
const IMAGE_QUALITY = 0.85;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/mpeg"]);
const EXTENSION_MIME_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
};

const refs = {
  root: document.querySelector("[data-chat-app]"),
  target: document.querySelector("[data-chat-target]"),
  dot: document.querySelector("[data-chat-dot]"),
  status: document.querySelector("[data-chat-status]"),
  retry: document.querySelector("[data-chat-retry]"),
  banner: document.querySelector("[data-chat-banner]"),
  bannerText: document.querySelector("[data-chat-banner-text]"),
  retryBanner: document.querySelector("[data-chat-retry-banner]"),
  openWriter: document.querySelector("[data-chat-open-writer]"),
  messages: document.querySelector("[data-chat-messages]"),
  empty: document.querySelector("[data-chat-empty]"),
  form: document.querySelector("[data-chat-form]"),
  input: document.querySelector("[data-chat-input]"),
  attachments: document.querySelector("[data-chat-attachments]"),
  attachError: document.querySelector("[data-chat-attach-error]"),
  attach: document.querySelector("[data-chat-attach]"),
  file: document.querySelector("[data-chat-file]"),
  send: document.querySelector("[data-chat-send]"),
  stop: document.querySelector("[data-chat-stop]"),
  unload: document.querySelector("[data-chat-unload]"),
  newChat: document.querySelector("[data-chat-new]"),
  close: document.querySelector("[data-chat-close]"),
  historyToggle: document.querySelector("[data-chat-history-toggle]"),
  history: document.querySelector("[data-chat-history]"),
  historyClose: document.querySelector("[data-chat-history-close]"),
  historyList: document.querySelector("[data-chat-history-list]"),
  historyEmpty: document.querySelector("[data-chat-history-empty]"),
  paramsToggle: document.querySelector("[data-chat-params-toggle]"),
  params: document.querySelector("[data-chat-params]"),
  paramsClose: document.querySelector("[data-chat-params-close]"),
  reset: document.querySelector("[data-chat-reset]"),
  system: document.querySelector("[data-chat-system]"),
  thinking: document.querySelector("[data-chat-thinking]"),
  thinkingToggle: document.querySelector("[data-chat-thinking-toggle]"),
  keepLoaded: document.querySelector("[data-chat-keep-loaded]"),
  temperature: document.querySelector("[data-chat-temperature]"),
  topP: document.querySelector("[data-chat-top-p]"),
  topK: document.querySelector("[data-chat-top-k]"),
  maxTokens: document.querySelector("[data-chat-max-tokens]"),
  seed: document.querySelector("[data-chat-seed]"),
};

const state = {
  config: null,
  modelInfo: null,
  connection: "checking",
  phase: null,
  banner: null,
  messages: [],
  attachments: [],
  conversationRevision: 0,
  probeRevision: 0,
  streaming: false,
  unloading: false,
  finalized: true,
  aborted: false,
  done: false,
  controller: null,
  assistant: null,
  assistantText: "",
  reasoningText: "",
  usage: null,
  stats: null,
  streamError: null,
  refreshAfterStream: false,
  keepLoaded: true,
  conversationId: null,
  history: [],
  historyPendingDelete: null,
};

let hostLocale = null;
let hostTheme = null;
let historyDeleteTimer = null;

function postToWriter(message) {
  try {
    const target = embeddedHost || window.opener;
    target?.postMessage(message, window.location.origin);
    return target;
  } catch (error) {
    console.warn(`[H3 Writer chat] could not message the Prompt Writer: ${error?.message || error}`);
    return null;
  }
}

// The Prompt Writer cannot see this iframe's stream state, and it refuses to
// close its window while a reply is generating.
function reportBusy(busy) {
  postToWriter({ type: "h3ps-chat-busy", busy });
  console.log(`[H3 Writer chat] reported busy=${busy} to the Prompt Writer`);
}

function applyPreferences() {
  const preferences = loadUserPreferences(localStorage);
  const storedTheme = preferences?.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = hostTheme || storedTheme;
  configureI18n({
    preference: hostLocale || preferences?.language || "auto",
    app: comfyApp,
    navigatorLanguage: navigator.language,
    root: refs.root,
  });
  translateDom(refs.root);
}

function displayTarget() {
  const model = state.modelInfo?.name || state.config?.model || "llama.cpp";
  const url = state.config?.url || "";
  return url ? t("chat.target", { model: model.split("/").pop(), url }) : t("chat.subtitle");
}

function renderTarget() {
  refs.target.textContent = displayTarget();
  refs.target.title = state.modelInfo?.name || state.config?.model || "";
}

function statusText() {
  if (state.connection === "busy") {
    return state.phase ? t(`chat.phase.${state.phase}`) : t("chat.status.busy");
  }
  return t({
    checking: "chat.status.checking",
    ready: "chat.status.connected",
    error: "chat.status.unavailable",
    unconfigured: "chat.status.unconfigured",
  }[state.connection] || "chat.status.checking");
}

function renderStatus() {
  refs.dot.dataset.state = state.connection;
  refs.status.textContent = statusText();
  refs.retry.hidden = state.streaming || !(state.connection === "error" || state.connection === "unconfigured");
}

function renderBanner() {
  if (!state.banner) {
    refs.banner.hidden = true;
    return;
  }
  refs.bannerText.textContent = state.banner.kind === "unconfigured"
    ? t("chat.not_configured")
    : localizedError(state.banner.error, "chat.status.unavailable").message;
  refs.retryBanner.hidden = state.banner.retry !== true;
  refs.openWriter.hidden = state.banner.writer !== true || !window.opener;
  refs.banner.hidden = false;
}

function renderConnection() {
  renderTarget();
  renderStatus();
  renderBanner();
  syncComposer();
}

function syncCopy() {
  document.title = t("chat.title");
  renderConnection();
  syncThinkingToggle();
  syncKeepLoaded();
  for (const article of refs.messages.querySelectorAll(".h3lc-message")) {
    const meta = article.querySelector(".h3lc-message-meta");
    if (meta) meta.textContent = t(article.classList.contains("is-user") ? "chat.you" : "chat.assistant");
    const summary = article.querySelector(".h3lc-reasoning summary");
    if (summary) summary.textContent = t("chat.thinking");
    for (const button of article.querySelectorAll("[data-chat-copy]")) {
      button.textContent = t(button.dataset.copied === "true" ? "chat.copied" : "chat.copy");
      button.title = t("chat.copy_title");
      button.setAttribute("aria-label", t("chat.copy_title"));
    }
    for (const button of article.querySelectorAll("[data-chat-delete]")) {
      button.textContent = t("chat.delete");
      button.title = t("chat.delete_title");
      button.setAttribute("aria-label", t("chat.delete_title"));
    }
    const stats = article.querySelector("[data-chat-stats]");
    if (stats) renderStatsLine(stats);
  }
  if (state.streaming && state.phase && state.assistant) {
    state.assistant.phase.textContent = t(`chat.phase.${state.phase}`);
  }
  if (state.streaming) refs.stop.textContent = t(state.aborted ? "chat.stopping" : "chat.stop");
  for (const item of refs.attachments.querySelectorAll(".h3lc-attachment")) {
    const label = item.querySelector(".h3lc-attachment-label");
    if (label) label.textContent = t(item.dataset.kind === "video" ? "chat.attachment_video" : "chat.attachment_image");
    const remove = item.querySelector(".h3lc-attachment-remove");
    if (remove) {
      remove.title = t("chat.attachment_remove");
      remove.setAttribute("aria-label", t("chat.attachment_remove"));
    }
  }
  for (const image of refs.messages.querySelectorAll(".h3lc-message-image")) {
    image.alt = t("chat.attachment_image");
  }
  for (const video of refs.messages.querySelectorAll(".h3lc-message-video")) {
    video.setAttribute("aria-label", t("chat.attachment_video"));
  }
  renderHistory();
}

function isLocalEndpoint(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function canManageModel() {
  return isLocalEndpoint(state.config?.url)
    && state.modelInfo?.lifecycle_supported === true
    && Boolean(state.modelInfo?.id);
}

function syncUnload() {
  if (!refs.unload) return;
  refs.unload.hidden = !canManageModel();
  refs.unload.disabled = state.streaming || state.unloading;
  refs.unload.textContent = t(state.unloading ? "chat.unloading" : "chat.unload");
  refs.unload.title = t("chat.unload_title");
}

function syncComposer() {
  const hasText = refs.input.value.trim().length > 0;
  const hasAttachments = state.attachments.length > 0;
  refs.send.disabled = state.streaming || (!hasText && !hasAttachments) || !state.config?.url;
  refs.attach.disabled = state.streaming;
  refs.stop.hidden = !state.streaming;
  if (!state.streaming) {
    refs.stop.disabled = false;
    refs.stop.textContent = t("chat.stop");
  }
  syncUnload();
  syncKeepLoaded();
  syncMessageActions();
  syncHistoryAvailability();
}

function syncMessageActions() {
  for (const button of refs.messages.querySelectorAll("[data-chat-delete]")) {
    button.disabled = state.streaming;
  }
}

function syncThinkingToggle() {
  if (!refs.thinkingToggle) return;
  const on = refs.thinking.checked;
  const label = t(on ? "chat.thinking_on_title" : "chat.thinking_off_title");
  refs.thinkingToggle.setAttribute("aria-pressed", String(on));
  refs.thinkingToggle.title = label;
  refs.thinkingToggle.setAttribute("aria-label", label);
}

function syncKeepLoaded() {
  if (!refs.keepLoaded) return;
  const on = state.keepLoaded;
  const label = t(on ? "chat.keep_loaded_on_title" : "chat.keep_loaded_off_title");
  refs.keepLoaded.hidden = !canManageModel();
  refs.keepLoaded.disabled = state.streaming;
  refs.keepLoaded.setAttribute("aria-pressed", String(on));
  refs.keepLoaded.title = label;
  refs.keepLoaded.setAttribute("aria-label", label);
}

function resizeInput() {
  refs.input.style.height = "auto";
  refs.input.style.height = `${Math.min(refs.input.scrollHeight, 190)}px`;
}

function showAttachmentError(message) {
  refs.attachError.textContent = message || "";
  refs.attachError.hidden = !message;
}

function pendingAttachmentCounts() {
  return state.attachments.reduce(
    (counts, attachment) => {
      counts[attachment.kind === "video" ? "videos" : "images"] += 1;
      return counts;
    },
    { images: 0, videos: 0 },
  );
}

function fileMime(file) {
  const type = (file.type || "").toLowerCase();
  if (IMAGE_MIME_TYPES.has(type) || VIDEO_MIME_TYPES.has(type)) return type;
  const extension = (file.name || "").split(".").pop()?.toLowerCase() || "";
  return EXTENSION_MIME_TYPES[extension] || type;
}

function attachmentFailure(key) {
  const error = new Error(key);
  error.i18nKey = key;
  return error;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function decodeImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = dataUrl;
  });
}

async function compressImage(file) {
  let source;
  try {
    source = await readFileAsDataUrl(file);
  } catch (error) {
    throw attachmentFailure("chat.attach.error_read");
  }
  let image;
  try {
    image = await decodeImage(source);
  } catch (error) {
    throw attachmentFailure("chat.attach.error_image_decode");
  }
  const sourceWidth = image.naturalWidth || image.width || 0;
  const sourceHeight = image.naturalHeight || image.height || 0;
  if (!sourceWidth || !sourceHeight) throw attachmentFailure("chat.attach.error_image_decode");
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw attachmentFailure("chat.attach.error_image_decode");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
  if (!dataUrl.startsWith("data:image/jpeg")) throw attachmentFailure("chat.attach.error_image_decode");
  const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) throw attachmentFailure("chat.attach.error_image_size");
  return { kind: "image", name: file.name || "image", mime: "image/jpeg", bytes, dataUrl, width, height };
}

function readVideoDuration(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const finish = (callback, value) => {
      video.removeAttribute("src");
      video.load?.();
      callback(value);
    };
    video.onloadedmetadata = () => finish(resolve, video.duration);
    video.onerror = () => finish(reject, attachmentFailure("chat.attach.error_video_metadata"));
    video.src = url;
  });
}

async function prepareVideo(file, mime) {
  if (file.size > MAX_VIDEO_BYTES) throw attachmentFailure("chat.attach.error_video_size");
  const objectUrl = URL.createObjectURL(file);
  let duration;
  try {
    duration = await readVideoDuration(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_SECONDS) {
    throw attachmentFailure("chat.attach.error_video_duration");
  }
  let dataUrl;
  try {
    dataUrl = await readFileAsDataUrl(file);
  } catch (error) {
    throw attachmentFailure("chat.attach.error_read");
  }
  return { kind: "video", name: file.name || "video", mime, bytes: file.size, dataUrl, duration };
}

function renderAttachments() {
  refs.attachments.replaceChildren();
  refs.attachments.hidden = state.attachments.length === 0;
  for (const [index, attachment] of state.attachments.entries()) {
    const item = document.createElement("div");
    item.className = "h3lc-attachment";
    item.dataset.kind = attachment.kind;
    const media = document.createElement(attachment.kind === "video" ? "video" : "img");
    media.className = "h3lc-attachment-media";
    media.src = attachment.dataUrl;
    if (attachment.kind === "video") {
      media.muted = true;
      media.playsInline = true;
      media.preload = "metadata";
    } else {
      media.alt = t("chat.attachment_image");
    }
    const label = document.createElement("span");
    label.className = "h3lc-attachment-label";
    label.textContent = t(attachment.kind === "video" ? "chat.attachment_video" : "chat.attachment_image");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "h3lc-attachment-remove";
    remove.textContent = "✕";
    remove.title = t("chat.attachment_remove");
    remove.setAttribute("aria-label", t("chat.attachment_remove"));
    remove.addEventListener("click", () => removeAttachment(index));
    item.append(media, label, remove);
    refs.attachments.append(item);
  }
  refs.attachError.hidden = !refs.attachError.textContent;
}

function removeAttachment(index) {
  const [removed] = state.attachments.splice(index, 1);
  if (removed) {
    console.log(`[H3 Writer chat] attachment removed kind=${removed.kind} bytes=${removed.bytes} remaining=${state.attachments.length}`);
  }
  renderAttachments();
  syncComposer();
}

async function addAttachments(files) {
  const list = [...files];
  if (!list.length || state.streaming) return;
  showAttachmentError(null);
  console.log(
    `[H3 Writer chat] attachments selected files=${list.length} ` +
    `types=${list.map((file) => file.type || "unknown").join(",") || "none"} ` +
    `bytes=${list.map((file) => file.size).join(",") || "0"}`,
  );
  for (const file of list) {
    const mime = fileMime(file);
    const kind = IMAGE_MIME_TYPES.has(mime) ? "image" : VIDEO_MIME_TYPES.has(mime) ? "video" : null;
    if (!kind) {
      showAttachmentError(t("chat.attach.error_type"));
      console.warn(`[H3 Writer chat] attachment rejected type=${file.type || "unknown"} name=${file.name || ""}`);
      continue;
    }
    const counts = pendingAttachmentCounts();
    if (kind === "image" && counts.images >= MAX_IMAGES_PER_MESSAGE) {
      showAttachmentError(t("chat.attach.error_image_count"));
      console.warn(`[H3 Writer chat] attachment rejected reason=image_limit images=${counts.images}`);
      continue;
    }
    if (kind === "video" && counts.videos >= MAX_VIDEOS_PER_MESSAGE) {
      showAttachmentError(t("chat.attach.error_video_count"));
      console.warn(`[H3 Writer chat] attachment rejected reason=video_limit videos=${counts.videos}`);
      continue;
    }
    try {
      const attachment = kind === "image" ? await compressImage(file) : await prepareVideo(file, mime);
      state.attachments.push(attachment);
      console.log(
        `[H3 Writer chat] attachment ready kind=${attachment.kind} mime=${attachment.mime} ` +
        `bytes=${attachment.bytes} total=${state.attachments.length}`,
      );
    } catch (error) {
      const key = error?.i18nKey
        || (kind === "image" ? "chat.attach.error_image_decode" : "chat.attach.error_video_metadata");
      showAttachmentError(t(key));
      console.warn(
        `[H3 Writer chat] attachment failed kind=${kind} key=${key} ` +
        `message=${error?.message || error} name=${file.name || ""} bytes=${file.size}`,
      );
    }
  }
  renderAttachments();
  syncComposer();
  refs.input.focus();
}

function nearBottom() {
  return refs.messages.scrollHeight - refs.messages.scrollTop - refs.messages.clientHeight < 96;
}

function scrollToBottom(wasNear = true) {
  if (wasNear) refs.messages.scrollTop = refs.messages.scrollHeight;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function apiError(payload, status) {
  const detail = payload?.error;
  const error = new Error(detail?.message || `HTTP ${status}`);
  error.code = detail?.code || "REQUEST_FAILED";
  error.details = detail?.details;
  error.status = status;
  return error;
}

async function refreshConnection() {
  if (state.streaming) return;
  const revision = ++state.probeRevision;
  state.config = loadExternalServerConfig(localStorage);
  if (!state.config?.url) {
    console.log("[H3 Writer chat] no external llama.cpp configuration");
    state.modelInfo = null;
    state.connection = "unconfigured";
    state.banner = { kind: "unconfigured", retry: true, writer: true };
    renderConnection();
    return;
  }
  state.connection = "checking";
  state.banner = null;
  renderConnection();
  console.log(`[H3 Writer chat] probing endpoint=${state.config.url} model=${state.config.model || "auto"}`);
  const started = performance.now();
  try {
    const response = await api.fetchApi(PROBE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: state.config.url, model: state.config.model || "" }),
    });
    const payload = await readJson(response);
    if (revision !== state.probeRevision) return;
    if (!response.ok) throw apiError(payload, response.status);
    state.modelInfo = payload?.model || null;
    state.connection = "ready";
    state.banner = null;
    console.log(`[H3 Writer chat] connected model=${state.modelInfo?.id || ""} endpoint=${state.config.url} elapsed=${Math.round(performance.now() - started)}ms`);
  } catch (error) {
    if (revision !== state.probeRevision) return;
    state.modelInfo = null;
    state.connection = "error";
    state.banner = { kind: "error", error, retry: true };
    console.error(`[H3 Writer chat] probe failed code=${error?.code || ""} message=${error?.message || ""} elapsed=${Math.round(performance.now() - started)}ms`, error?.details ?? "");
  }
  renderConnection();
}

async function unloadModel() {
  const modelId = state.modelInfo?.id;
  if (!modelId || state.unloading || state.streaming) return;
  state.unloading = true;
  syncComposer();
  console.log(`[H3 Writer chat] unloading model=${modelId}`);
  let failure = null;
  try {
    const response = await api.fetchApi(UNLOAD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ family: "external", model_id: modelId }),
    });
    const payload = await readJson(response);
    if (!response.ok) throw apiError(payload, response.status);
    state.banner = null;
    console.log(`[H3 Writer chat] model unloaded model=${modelId}`, payload);
  } catch (error) {
    failure = error;
    console.error(`[H3 Writer chat] model unload failed code=${error?.code || ""} message=${error?.message || ""}`, error?.details ?? "");
  } finally {
    state.unloading = false;
    await refreshConnection();
    if (failure) {
      state.banner = { kind: "error", error: failure, retry: false };
      renderBanner();
    }
    syncComposer();
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn(`[H3 Writer chat] clipboard API failed: ${error?.message || error}`);
    }
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    console.warn(`[H3 Writer chat] clipboard fallback failed: ${error?.message || error}`);
  }
  helper.remove();
  return copied;
}

// Copy always uses the original text, never the rendered Markdown. The raw
// source is attached to the article when the message is rendered.
function rawMessageText(article) {
  if (typeof article._rawText === "string") return article._rawText;
  const content = article._chatMessage?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return article.querySelector(".h3lc-message-body")?.textContent || "";
}

async function copyMessage(article, button) {
  const text = rawMessageText(article);
  if (!text) return;
  const copied = await copyTextToClipboard(text);
  if (!copied) {
    console.warn(`[H3 Writer chat] message copy failed chars=${text.length}`);
    return;
  }
  console.log(`[H3 Writer chat] message copied chars=${text.length}`);
  button.dataset.copied = "true";
  button.textContent = t("chat.copied");
  clearTimeout(button._copiedTimer);
  button._copiedTimer = setTimeout(() => {
    button.dataset.copied = "false";
    button.textContent = t("chat.copy");
  }, 1200);
}

function deleteMessage(article) {
  if (state.streaming) return;
  const role = article.classList.contains("is-user") ? "user" : "assistant";
  const message = article._chatMessage;
  const index = message ? state.messages.indexOf(message) : -1;
  if (index >= 0) state.messages.splice(index, 1);
  article.remove();
  if (!refs.messages.querySelector(".h3lc-message")) refs.empty.hidden = false;
  console.log(
    `[H3 Writer chat] message deleted role=${role} removed_from_context=${index >= 0} ` +
    `remaining=${state.messages.length}`,
  );
  persistConversation();
}

function createMessage(role) {
  refs.empty.hidden = true;
  const article = document.createElement("article");
  article.className = `h3lc-message is-${role}`;
  const meta = document.createElement("div");
  meta.className = "h3lc-message-meta";
  meta.textContent = t(role === "user" ? "chat.you" : "chat.assistant");
  const actions = document.createElement("div");
  actions.className = "h3lc-message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "h3lc-message-action";
  copy.dataset.chatCopy = "";
  copy.textContent = t("chat.copy");
  copy.title = t("chat.copy_title");
  copy.setAttribute("aria-label", t("chat.copy_title"));
  copy.addEventListener("click", () => copyMessage(article, copy));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "h3lc-message-action";
  remove.dataset.chatDelete = "";
  remove.textContent = t("chat.delete");
  remove.title = t("chat.delete_title");
  remove.setAttribute("aria-label", t("chat.delete_title"));
  remove.addEventListener("click", () => deleteMessage(article));
  actions.append(copy, remove);
  article.append(meta);
  refs.messages.append(article);
  return { article, meta, actions, copy, remove };
}

function appendUserMessage(text, attachments = [], message = null) {
  const { article, actions, copy } = createMessage("user");
  article._chatMessage = message;
  article._rawText = text;
  copy.disabled = !text;
  if (text) {
    const body = document.createElement("div");
    body.className = "h3lc-message-body";
    body.textContent = text;
    article.append(body);
  }
  if (attachments.length) {
    const media = document.createElement("div");
    media.className = "h3lc-message-media";
    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        const image = document.createElement("img");
        image.className = "h3lc-message-image";
        image.src = attachment.dataUrl;
        image.alt = t("chat.attachment_image");
        image.loading = "lazy";
        media.append(image);
      } else {
        const video = document.createElement("video");
        video.className = "h3lc-message-video";
        video.src = attachment.dataUrl;
        video.controls = true;
        video.preload = "metadata";
        video.setAttribute("aria-label", t("chat.attachment_video"));
        media.append(video);
      }
    }
    article.append(media);
  }
  article.append(actions);
  scrollToBottom(true);
  return article;
}

function buildUserContent(text, attachments) {
  if (!attachments.length) return text;
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    } else {
      parts.push({ type: "video_url", video_url: { url: attachment.dataUrl } });
    }
  }
  return parts;
}

function beginAssistant() {
  const { article, meta, actions, copy } = createMessage("assistant");
  copy.disabled = true;
  article.classList.add("is-streaming");
  const phase = document.createElement("div");
  phase.className = "h3lc-phase";
  phase.textContent = t("chat.phase.waiting");
  const reasoning = document.createElement("details");
  reasoning.className = "h3lc-reasoning";
  reasoning.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = t("chat.thinking");
  const reasoningBody = document.createElement("div");
  reasoningBody.className = "h3lc-reasoning-body";
  reasoning.append(summary, reasoningBody);
  const content = document.createElement("div");
  content.className = "h3lc-message-body h3lc-markdown";
  article.append(phase, reasoning, content, actions);
  state.assistant = {
    article, meta, phase, reasoning, reasoningBody, content, actions, copy,
    markdownFrame: null, markdownQueued: false, markdownScroll: true,
  };
  scrollToBottom(true);
}

function appendStreamText(container, text, wasNear) {
  container.appendChild(document.createTextNode(text));
  scrollToBottom(wasNear);
}

function cancelMarkdownRender(assistant) {
  if (assistant.markdownFrame !== null) {
    cancelAnimationFrame(assistant.markdownFrame);
    assistant.markdownFrame = null;
  }
  assistant.markdownQueued = false;
}

// The stream delivers many small chunks, so rebuild at most once per frame.
// Keep the near-bottom decision from the chunk that scheduled the frame so
// the view does not jump while new text grows below the viewport.
function scheduleMarkdownRender(assistant, wasNear) {
  // Keep copy on the original source even while the reply is still streaming.
  assistant.article._rawText = state.assistantText;
  if (!assistant.markdownQueued) {
    assistant.markdownScroll = wasNear;
    assistant.markdownQueued = true;
  }
  if (assistant.markdownFrame !== null) return;
  assistant.markdownFrame = requestAnimationFrame(() => {
    assistant.markdownFrame = null;
    assistant.markdownQueued = false;
    if (state.assistant !== assistant) return;
    renderMarkdown(assistant.content, state.assistantText);
    scrollToBottom(assistant.markdownScroll);
  });
}

function handleStreamEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "status") {
    if (event.phase === "loading_model" || event.phase === "generating") {
      state.phase = event.phase;
      if (state.assistant) state.assistant.phase.textContent = t(`chat.phase.${event.phase}`);
      renderStatus();
    }
    return;
  }
  if (event.type === "reasoning" && typeof event.text === "string" && event.text) {
    const wasNear = nearBottom();
    state.reasoningText += event.text;
    const assistant = state.assistant;
    if (!assistant) return;
    assistant.reasoning.hidden = false;
    if (!assistant.reasoning.open) assistant.reasoning.open = true;
    assistant.phase.hidden = true;
    appendStreamText(assistant.reasoningBody, event.text, wasNear);
    return;
  }
  if (event.type === "content" && typeof event.text === "string" && event.text) {
    const wasNear = nearBottom();
    state.assistantText += event.text;
    const assistant = state.assistant;
    if (!assistant) return;
    assistant.phase.hidden = true;
    assistant.copy.disabled = false;
    scheduleMarkdownRender(assistant, wasNear);
    return;
  }
  if (event.type === "warning") {
    const warning = Object.assign(new Error(String(event.message || "")), { code: event.code, details: event.details });
    console.warn(`[H3 Writer chat] warning code=${warning.code || ""} message=${warning.message}`);
    if (state.assistant) {
      const note = document.createElement("p");
      note.className = "h3lc-note";
      note.textContent = localizedError(warning, "chat.error.title").message;
      state.assistant.article.append(note);
    }
    return;
  }
  if (event.type === "done") {
    const elapsed = Number(event.elapsed);
    const speed = Number(event.tokens_per_second);
    state.done = true;
    state.usage = event.usage || null;
    state.stats = {
      elapsed: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : null,
      tokensPerSecond: Number.isFinite(speed) && speed > 0 ? speed : null,
    };
    console.log(
      `[H3 Writer chat] done finish_reason=${event.finish_reason || ""} ` +
      `elapsed=${state.stats.elapsed ?? ""}s tokens_per_second=${state.stats.tokensPerSecond ?? ""}`,
    );
    state.phase = null;
    return;
  }
  if (event.type === "error") {
    state.streamError = Object.assign(new Error(String(event.message || t("chat.error.title"))), {
      code: event.code,
      details: event.details,
    });
    state.phase = null;
    console.error(`[H3 Writer chat] stream error code=${event.code || ""} message=${event.message || ""}`, event.details ?? "");
  }
}

async function consumeStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch (error) {
        console.warn(`[H3 Writer chat] ignored malformed stream event: ${error?.message || error}`);
        continue;
      }
      handleStreamEvent(event);
    }
  }
}

function addNote(article, text) {
  const note = document.createElement("p");
  note.className = "h3lc-note";
  note.textContent = text;
  article.append(note);
}

function addErrorBox(article, error) {
  const localized = localizedError(error, "chat.error.title");
  const box = document.createElement("div");
  box.className = "h3lc-error";
  const message = document.createElement("span");
  message.textContent = localized.message;
  box.append(message);
  if (localized.technical) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = t("chat.error.technical");
    const pre = document.createElement("pre");
    pre.textContent = localized.technical;
    details.append(summary, pre);
    box.append(details);
  }
  article.append(box);
}

function addUsage(article, usage) {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  if (!prompt && !completion) return;
  const line = document.createElement("p");
  line.className = "h3lc-usage";
  line.textContent = t("chat.usage", { prompt, completion });
  article.append(line);
}

function renderStatsLine(line) {
  const elapsed = Number(line.dataset.elapsed) || 0;
  const speed = Number(line.dataset.tokensPerSecond) || 0;
  const seconds = elapsed.toFixed(1);
  line.textContent = speed > 0
    ? t("chat.stats", { seconds, speed: speed.toFixed(1) })
    : t("chat.stats_elapsed", { seconds });
}

function addStats(article, stats) {
  if (!stats?.elapsed) return;
  const line = document.createElement("p");
  line.className = "h3lc-usage";
  line.dataset.chatStats = "";
  line.dataset.elapsed = String(stats.elapsed);
  if (stats.tokensPerSecond) line.dataset.tokensPerSecond = String(stats.tokensPerSecond);
  renderStatsLine(line);
  article.append(line);
}

function finishStream({ error = null, aborted = false, revision = state.conversationRevision } = {}) {
  if (state.finalized) return;
  state.finalized = true;
  state.streaming = false;
  reportBusy(false);
  state.controller = null;
  const current = revision === state.conversationRevision;
  const assistant = state.assistant;
  if (assistant) {
    assistant.article.classList.remove("is-streaming");
    assistant.phase.hidden = true;
    cancelMarkdownRender(assistant);
    if (!state.reasoningText) assistant.reasoning.hidden = true;
    if (current) {
      // Render the final source synchronously so the last chunks are never
      // lost when the pending animation frame was cancelled.
      renderMarkdown(assistant.content, state.assistantText);
      assistant.article._rawText = state.assistantText;
      if (aborted) addNote(assistant.article, t("chat.stopped"));
      if (error) addErrorBox(assistant.article, error);
      if (state.usage) addUsage(assistant.article, state.usage);
      if (state.stats) addStats(assistant.article, state.stats);
      if (state.assistantText) {
        const message = { role: "assistant", content: state.assistantText };
        state.messages.push(message);
        assistant.article._chatMessage = message;
      }
    }
    scrollToBottom(true);
  }
  state.assistant = null;
  state.phase = null;
  state.connection = state.modelInfo ? "ready" : "error";
  if (current) persistConversation();
  console.log(
    `[H3 Writer chat] finished aborted=${aborted} error=${error?.code || ""} ` +
    `content_chars=${state.assistantText.length} reasoning_chars=${state.reasoningText.length}`,
  );
  renderConnection();
  if (state.refreshAfterStream) {
    state.refreshAfterStream = false;
    refreshConnection();
  }
  refs.input.focus();
}

async function sendMessage() {
  if (state.streaming) return;
  const text = refs.input.value.trim();
  const attachments = state.attachments;
  if ((!text && !attachments.length) || !state.config?.url) return;
  const revision = state.conversationRevision;
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  const videoCount = attachments.length - imageCount;
  const mediaBytes = attachments.reduce((total, attachment) => total + attachment.bytes, 0);
  const message = { role: "user", content: buildUserContent(text, attachments) };
  state.messages.push(message);
  appendUserMessage(text, attachments, message);
  state.attachments = [];
  renderAttachments();
  refs.file.value = "";
  showAttachmentError(null);
  refs.input.value = "";
  resizeInput();
  beginAssistant();
  state.streaming = true;
  reportBusy(true);
  state.finalized = false;
  state.aborted = false;
  state.done = false;
  state.controller = null;
  state.assistantText = "";
  state.reasoningText = "";
  state.usage = null;
  state.stats = null;
  state.streamError = null;
  state.connection = "busy";
  state.phase = "waiting";
  renderConnection();
  syncComposer();

  const controller = new AbortController();
  state.controller = controller;
  const systemPrompt = refs.system.value.trim();
  const payload = {
    url: state.config.url,
    model: state.config.model || "",
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...state.messages,
    ],
    ...samplingOptions(),
    keep_loaded: state.keepLoaded,
  };
  console.log(
    `[H3 Writer chat] sending messages=${state.messages.length} images=${imageCount} videos=${videoCount} ` +
    `media_bytes=${mediaBytes} system=${Boolean(systemPrompt)} ` +
    `endpoint=${state.config.url} model=${payload.model || "(default)"} thinking=${payload.thinking} ` +
    `keep_loaded=${payload.keep_loaded}`,
  );
  try {
    const response = await api.fetchApi(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      timeoutMs: null,
    });
    if (!response.ok) {
      throw apiError(await readJson(response), response.status);
    }
    if (!response.body) {
      throw Object.assign(new Error("Streaming responses are not supported in this browser."), { code: "STREAM_UNSUPPORTED" });
    }
    await consumeStream(response.body);
    if (state.finalized) return;
    if (state.streamError) finishStream({ error: state.streamError, revision });
    else if (state.aborted) finishStream({ aborted: true, revision });
    else if (!state.done) finishStream({ error: new Error(t("chat.error.stream")), revision });
    else finishStream({ revision });
  } catch (error) {
    if (state.finalized) return;
    console.error(`[H3 Writer chat] request failed code=${error?.code || ""} message=${error?.message || ""}`, error?.details ?? "");
    if (state.aborted || error?.name === "AbortError") finishStream({ aborted: true, revision });
    else finishStream({ error, revision });
  }
}

function stopStream() {
  if (!state.streaming) return;
  state.aborted = true;
  refs.stop.disabled = true;
  refs.stop.textContent = t("chat.stopping");
  console.log("[H3 Writer chat] stop requested");
  api.fetchApi(CANCEL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch((error) => console.warn(`[H3 Writer chat] cancel request failed: ${error?.message || error}`));
  state.controller?.abort();
}

function createConversationId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch (error) {
    console.warn(`[H3 Writer chat] randomUUID unavailable: ${error?.message || error}`);
  }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function historyTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function clearPendingHistoryDelete() {
  clearTimeout(historyDeleteTimer);
  historyDeleteTimer = null;
  state.historyPendingDelete = null;
}

// Text-only snapshots keep the browser quota clear of attachment data URLs.
function persistConversation() {
  if (!state.conversationId && !state.messages.length) return;
  if (!state.conversationId) state.conversationId = createConversationId();
  if (!state.messages.length) {
    if (state.history.some((entry) => entry.id === state.conversationId)) {
      state.history = deleteChatConversation(localStorage, state.conversationId);
      renderHistory();
      console.log(`[H3 Writer chat] history removed empty conversation id=${state.conversationId}`);
    }
    state.conversationId = null;
    return;
  }
  const messages = sanitizeConversationMessages(state.messages);
  if (!messages.length) return;
  const previous = state.history.find((entry) => entry.id === state.conversationId);
  const now = Date.now();
  const conversation = {
    id: state.conversationId,
    title: conversationTitle(messages, t("chat.history_untitled")),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    messages,
  };
  state.history = saveChatConversation(localStorage, conversation);
  renderHistory();
  console.log(
    `[H3 Writer chat] history saved id=${conversation.id} messages=${messages.length} ` +
    `media_omitted=${messages.reduce((total, message) => total + message.media, 0)} ` +
    `total=${state.history.length}`,
  );
}

function syncHistoryAvailability() {
  const busy = state.streaming || state.unloading;
  for (const button of refs.historyList.querySelectorAll("button")) {
    button.disabled = busy;
  }
}

function renderHistory() {
  if (
    state.historyPendingDelete
    && !state.history.some((entry) => entry.id === state.historyPendingDelete)
  ) {
    clearPendingHistoryDelete();
  }
  refs.historyList.replaceChildren();
  refs.historyEmpty.hidden = state.history.length > 0;
  const busy = state.streaming || state.unloading;
  for (const entry of state.history) {
    const item = document.createElement("li");
    item.className = "h3lc-history-item";
    if (entry.id === state.conversationId) item.classList.add("is-active");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "h3lc-history-open";
    open.disabled = busy;
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const when = document.createElement("small");
    when.textContent = historyTimestamp(entry.updatedAt);
    open.append(title, when);
    open.addEventListener("click", () => loadConversation(entry.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "h3lc-history-delete";
    remove.disabled = busy;
    const confirming = entry.id === state.historyPendingDelete;
    remove.dataset.confirm = String(confirming);
    remove.textContent = t(confirming ? "chat.history_confirm_delete" : "chat.delete");
    const label = t(confirming
      ? "chat.history_confirm_delete_title"
      : "chat.history_delete_title");
    remove.title = label;
    remove.setAttribute("aria-label", label);
    remove.addEventListener("click", () => requestDeleteConversation(entry.id));

    item.append(open, remove);
    refs.historyList.append(item);
  }
}

function resetConversationView() {
  state.messages = [];
  state.assistantText = "";
  state.reasoningText = "";
  state.usage = null;
  state.stats = null;
  state.streamError = null;
  state.assistant = null;
  refs.messages.replaceChildren(refs.empty);
  refs.empty.hidden = false;
  state.attachments = [];
  renderAttachments();
  showAttachmentError(null);
  refs.file.value = "";
  refs.input.value = "";
  resizeInput();
  syncComposer();
}

function loadConversation(id) {
  if (state.streaming || state.unloading) return;
  const entry = state.history.find((item) => item.id === id);
  if (!entry) {
    console.warn(`[H3 Writer chat] history load ignored missing id=${id}`);
    return;
  }
  if (entry.id === state.conversationId) {
    setHistoryOpen(false);
    return;
  }
  persistConversation();
  clearPendingHistoryDelete();
  state.conversationRevision += 1;
  state.assistantText = "";
  state.reasoningText = "";
  state.usage = null;
  state.stats = null;
  state.streamError = null;
  state.assistant = null;
  state.messages = [];
  state.conversationId = entry.id;
  refs.messages.replaceChildren(refs.empty);
  refs.empty.hidden = true;
  for (const stored of entry.messages) {
    // Media was dropped from the saved copy. A media-only turn still needs
    // non-empty context text so the next request stays valid.
    const content = stored.text
      || (stored.media ? t("chat.history_media_omitted", { count: stored.media }) : "");
    const message = { role: stored.role, content };
    if (stored.role === "user") {
      const article = appendUserMessage(stored.text, [], message);
      if (stored.media) {
        addNote(article, t("chat.history_media_omitted", { count: stored.media }));
      }
    } else {
      const { article, actions, copy } = createMessage("assistant");
      article._chatMessage = message;
      article._rawText = stored.text;
      copy.disabled = !stored.text;
      const body = document.createElement("div");
      body.className = "h3lc-message-body h3lc-markdown";
      renderMarkdown(body, stored.text);
      article.append(body, actions);
    }
    state.messages.push(message);
  }
  scrollToBottom(true);
  syncComposer();
  renderHistory();
  setHistoryOpen(false);
  refs.input.focus();
  console.log(
    `[H3 Writer chat] history loaded id=${entry.id} messages=${entry.messages.length}`,
  );
}

function requestDeleteConversation(id) {
  if (state.streaming || state.unloading) return;
  if (state.historyPendingDelete !== id) {
    state.historyPendingDelete = id;
    clearTimeout(historyDeleteTimer);
    historyDeleteTimer = setTimeout(() => {
      state.historyPendingDelete = null;
      historyDeleteTimer = null;
      renderHistory();
      console.log(`[H3 Writer chat] history delete cancelled id=${id}`);
    }, 3000);
    renderHistory();
    console.log(`[H3 Writer chat] history delete armed id=${id}`);
    return;
  }
  clearPendingHistoryDelete();
  const wasCurrent = state.conversationId === id;
  state.history = deleteChatConversation(localStorage, id);
  if (wasCurrent) {
    state.conversationId = null;
    resetConversationView();
  }
  renderHistory();
  console.log(
    `[H3 Writer chat] history deleted id=${id} current=${wasCurrent} ` +
    `remaining=${state.history.length}`,
  );
}

function newChat() {
  persistConversation();
  if (state.streaming) stopStream();
  state.conversationRevision += 1;
  state.conversationId = null;
  clearPendingHistoryDelete();
  resetConversationView();
  renderHistory();
  refs.input.focus();
  console.log("[H3 Writer chat] new conversation");
}

function setParamsOpen(open) {
  if (open && !refs.history.hidden) setHistoryOpen(false);
  const wasOpen = !refs.params.hidden;
  refs.params.hidden = !open;
  refs.paramsToggle.setAttribute("aria-expanded", String(open));
  if (open) refs.system.focus();
  else if (wasOpen) refs.paramsToggle.focus();
}

function setHistoryOpen(open) {
  if (open && !refs.params.hidden) setParamsOpen(false);
  const wasOpen = !refs.history.hidden;
  refs.history.hidden = !open;
  refs.historyToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    renderHistory();
    refs.historyClose.focus();
    console.log(`[H3 Writer chat] history opened conversations=${state.history.length}`);
  } else if (wasOpen) {
    refs.historyToggle.focus();
  }
}

function logThinking() {
  console.log(`[H3 Writer chat] thinking=${refs.thinking.checked ? "on" : "off"}`);
}

function resetParameters() {
  refs.system.value = "";
  refs.thinking.checked = true;
  refs.temperature.value = PARAMETER_DEFAULTS.temperature;
  refs.topP.value = PARAMETER_DEFAULTS.topP;
  refs.topK.value = PARAMETER_DEFAULTS.topK;
  refs.maxTokens.value = PARAMETER_DEFAULTS.maxTokens;
  refs.seed.value = PARAMETER_DEFAULTS.seed;
  syncThinkingToggle();
  logThinking();
  refs.temperature.focus();
}

function numericValue(input) {
  const raw = input.value.trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function samplingOptions() {
  const options = { thinking: refs.thinking.checked };
  const temperature = numericValue(refs.temperature);
  const topP = numericValue(refs.topP);
  const topK = numericValue(refs.topK);
  const maxTokens = numericValue(refs.maxTokens);
  const seed = numericValue(refs.seed);
  if (temperature !== undefined) options.temperature = temperature;
  if (topP !== undefined) options.top_p = topP;
  if (topK !== undefined) options.top_k = Math.trunc(topK);
  if (maxTokens !== undefined) options.max_tokens = Math.trunc(maxTokens);
  if (seed !== undefined) options.seed = Math.trunc(seed);
  return options;
}

refs.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

refs.input.addEventListener("input", () => {
  resizeInput();
  syncComposer();
});

refs.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!state.streaming) sendMessage();
});

refs.attach.addEventListener("click", () => refs.file?.click());
refs.file?.addEventListener("change", () => {
  const files = [...(refs.file.files || [])];
  refs.file.value = "";
  if (files.length) addAttachments(files);
});

refs.form.addEventListener("dragover", (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  refs.form.classList.add("is-dragging");
});

refs.form.addEventListener("dragleave", (event) => {
  if (refs.form.contains(event.relatedTarget)) return;
  refs.form.classList.remove("is-dragging");
});

refs.form.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  refs.form.classList.remove("is-dragging");
  addAttachments(files);
});

refs.input.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  addAttachments(files);
});

refs.send.addEventListener("click", () => sendMessage());
refs.stop.addEventListener("click", () => stopStream());
refs.unload?.addEventListener("click", () => unloadModel());
refs.newChat.addEventListener("click", () => newChat());
refs.historyToggle.addEventListener("click", () => setHistoryOpen(refs.history.hidden));
refs.historyClose.addEventListener("click", () => setHistoryOpen(false));
refs.close.addEventListener("click", () => {
  if (embeddedHost) {
    postToWriter({ type: "h3ps-close-chat" });
    return;
  }
  window.close();
});
refs.retry.addEventListener("click", () => refreshConnection());
refs.retryBanner.addEventListener("click", () => refreshConnection());
refs.openWriter.addEventListener("click", () => {
  const writer = postToWriter({ type: "h3ps-open-settings" });
  writer?.focus?.();
});
refs.paramsToggle.addEventListener("click", () => setParamsOpen(refs.params.hidden));
refs.paramsClose.addEventListener("click", () => setParamsOpen(false));
refs.reset.addEventListener("click", () => resetParameters());
refs.thinkingToggle?.addEventListener("click", () => {
  refs.thinking.checked = !refs.thinking.checked;
  syncThinkingToggle();
  logThinking();
});
refs.thinking.addEventListener("change", () => {
  syncThinkingToggle();
  logThinking();
});
refs.keepLoaded?.addEventListener("click", () => {
  state.keepLoaded = !state.keepLoaded;
  syncKeepLoaded();
  console.log(`[H3 Writer chat] keep_loaded=${state.keepLoaded ? "on" : "off"}`);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!refs.history.hidden) {
    event.preventDefault();
    setHistoryOpen(false);
    return;
  }
  if (!refs.params.hidden) {
    event.preventDefault();
    setParamsOpen(false);
  }
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === "h3ps-theme") {
    const next = event.data.theme === "light" ? "light" : event.data.theme === "dark" ? "dark" : null;
    if (!next || next === hostTheme) return;
    hostTheme = next;
    applyPreferences();
    syncCopy();
    console.log(`[H3 Writer chat] host theme=${next}`);
    return;
  }
  if (event.data?.type !== "h3ps-locale") return;
  const next = event.data.locale === "zh-CN" ? "zh-CN" : event.data.locale === "en" ? "en" : null;
  if (!next || next === hostLocale) return;
  hostLocale = next;
  applyPreferences();
  syncCopy();
  console.log(`[H3 Writer chat] host locale=${next}`);
});

window.addEventListener("pagehide", () => {
  persistConversation();
});

window.addEventListener("storage", (event) => {
  if (event.key === CHAT_HISTORY_STORAGE_KEY) {
    state.history = loadChatHistory(localStorage);
    renderHistory();
    console.log(
      `[H3 Writer chat] history changed in another tab total=${state.history.length}`,
    );
    return;
  }
  if (event.key === USER_PREFERENCES_STORAGE_KEY) {
    applyPreferences();
    syncCopy();
    return;
  }
  if (event.key === EXTERNAL_SERVER_STORAGE_KEY) {
    console.log("[H3 Writer chat] external llama.cpp configuration changed");
    if (state.streaming) state.refreshAfterStream = true;
    else refreshConnection();
  }
});

console.log(`[H3 Writer chat] booted embedded=${Boolean(embeddedHost)} api=${hostApi ? "host" : "fetch"}`);
state.history = loadChatHistory(localStorage);
console.log(`[H3 Writer chat] history loaded conversations=${state.history.length}`);
applyPreferences();
syncCopy();
resizeInput();
syncComposer();
refs.input.focus();
refreshConnection();
