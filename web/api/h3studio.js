import { api } from "/scripts/api.js";
import { readApiResponse } from "./response.js";

const PREFIX = "/h3studio";

async function request(path, options) {
  const response = await api.fetchApi(`${PREFIX}${path}`, options);
  return readApiResponse(response);
}

function post(path, body = {}) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ollamaQuery = (name, host) => host ? `?${name}=${encodeURIComponent(host)}` : "";

export const getStatus = (ollamaHost = null) => request(`/status${ollamaQuery("ollama_host", ollamaHost)}`);
export const getModels = () => request("/models");
export const diagnoseGGUFRuntime = (refresh = false) => post("/runtime/gguf/diagnostics", { refresh });
export const probeExternalServer = (payload) => post("/external-server/probe", payload);
export const getOllamaStatus = (host = null) => request(`/ollama/status${ollamaQuery("host", host)}`);
export const getApiProviderPresets = () => request("/api-provider/presets");
export const probeApiProvider = (payload) => post("/api-provider/probe", payload);
export const getApiProviderModels = (connectionId) => post("/api-provider/models", { connection_id: connectionId });
export const disconnectApiProvider = (connectionId) => post("/api-provider/disconnect", { connection_id: connectionId });
export const getGuides = () => request("/guides");
export const getGuide = (mode) => request(`/guides/${encodeURIComponent(mode)}`);
export const getSystemPrompt = (mode) => request(`/system-prompt/${encodeURIComponent(mode)}`);
export const assemble = (payload) => post("/assemble", payload);
export const generate = (payload) => post("/generate", payload);
export const cancel = () => post("/cancel");
export const unloadModel = (target = {}) => post("/unload", target);
export const refine = (payload) => post("/refine", payload);

export async function freeComfyVram() {
  const response = await api.fetchApi("/free", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: false }),
  });
  if (!response.ok) {
    throw new Error(`ComfyUI memory release failed (${response.status})`);
  }
}

export async function fetchComfyImageFile(source, filenameOverride = null) {
  const filename = String(source?.filename ?? "").trim();
  const subfolder = String(source?.subfolder ?? "").trim();
  const type = String(source?.type ?? "input").trim().toLowerCase();
  if (!filename || filename.includes("/") || !["input", "output", "temp"].includes(type)) {
    const error = new Error("The workflow image source cannot be resolved through ComfyUI's image view endpoint.");
    error.code = "WORKFLOW_REFERENCE_UNAVAILABLE";
    throw error;
  }
  const query = new URLSearchParams({ filename, subfolder, type });
  const response = await api.fetchApi(`/view?${query.toString()}`);
  if (!response.ok) {
    const error = new Error(`ComfyUI could not read workflow image ${filename} (${response.status}).`);
    error.code = "WORKFLOW_REFERENCE_READ_FAILED";
    throw error;
  }
  const blob = await response.blob();
  const contentType = blob.type || response.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) {
    const error = new Error(`Workflow source ${filename} did not resolve to an image.`);
    error.code = "WORKFLOW_REFERENCE_READ_FAILED";
    throw error;
  }
  return new File([blob], filenameOverride || filename, { type: contentType });
}

export function materializeWorkflowImage(sessionId, mode, file, plan, replaceAssetId = null) {
  const body = new FormData();
  body.append("session_id", sessionId);
  body.append("mode", mode);
  body.append("materialization_plan", JSON.stringify(plan));
  body.append("file", file);
  const replace = replaceAssetId ? `?replace_asset_id=${encodeURIComponent(replaceAssetId)}` : "";
  return request(`/media/materialize-workflow-image${replace}`, { method: "POST", body });
}

export function uploadMedia(sessionId, mode, files, replaceAssetId = null) {
  const body = new FormData();
  body.append("session_id", sessionId);
  body.append("mode", mode);
  for (const file of files) body.append("file", file);
  const replace = replaceAssetId ? `?replace_asset_id=${encodeURIComponent(replaceAssetId)}` : "";
  return request(`/media/upload${replace}`, { method: "POST", body });
}

export const listMedia = (sessionId) => request(`/media?session_id=${encodeURIComponent(sessionId)}`);
export const removeMedia = (sessionId, assetId) => request(
  `/media/${encodeURIComponent(assetId)}?session_id=${encodeURIComponent(sessionId)}`,
  { method: "DELETE" },
);
export const clearMedia = (sessionId, mode) => request(
  `/media?session_id=${encodeURIComponent(sessionId)}&mode=${encodeURIComponent(mode)}`,
  { method: "DELETE" },
);
export const resampleMedia = (sessionId, assetId, options = {}) => post(
  `/media/${encodeURIComponent(assetId)}/resample`,
  { session_id: sessionId, ...options },
);
export const reorderMedia = (sessionId, mode, assetIds) => post(
  "/media/reorder",
  { session_id: sessionId, mode, asset_ids: assetIds },
);
export const getMediaManifest = (sessionId, mode) => request(
  `/media/manifest?session_id=${encodeURIComponent(sessionId)}&mode=${encodeURIComponent(mode)}`,
);
