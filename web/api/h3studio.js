import { api } from "/scripts/api.js";
import { networkError, readApiResponse } from "./response.js";

const PREFIX = "/h3studio";

async function request(path, options) {
  let response;
  try {
    response = await api.fetchApi(`${PREFIX}${path}`, options);
  } catch (error) {
    throw networkError(error);
  }
  return readApiResponse(response);
}

function post(path, body = {}, options = {}) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
}

// ComfyUI aborts fetchApi requests after 60s by default. Local prompt models
// routinely need longer, so generation and refinement wait without a deadline.
const noFetchTimeout = { timeoutMs: null };

const ollamaQuery = (name, host) => host ? `?${name}=${encodeURIComponent(host)}` : "";

export const getStatus = (ollamaHost = null) => request(`/status${ollamaQuery("ollama_host", ollamaHost)}`);
export const selectProjector = (modelId, projector) => post("/models/projector", { model_id: modelId, projector });
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
export const generate = (payload) => post("/generate", payload, noFetchTimeout);
export const cancel = () => post("/cancel");
export const unloadModel = (target = {}) => post("/unload", target);
export const refine = (payload) => post("/refine", payload, noFetchTimeout);

export async function freeComfyVram({ freeMemory = false } = {}) {
  console.log(`[H3 Writer] releasing ComfyUI resources unload_models=true free_memory=${freeMemory}`);
  let response;
  try {
    response = await api.fetchApi("/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: freeMemory }),
    });
  } catch (error) {
    console.warn(`[H3 Writer] ComfyUI resource release request failed: ${error?.message || error}`);
    throw networkError(error);
  }
  if (!response.ok) {
    console.warn(`[H3 Writer] ComfyUI resource release rejected status=${response.status}`);
    const error = new Error(`ComfyUI memory release failed (${response.status})`);
    error.code = "REQUEST_FAILED";
    throw error;
  }
  console.log(`[H3 Writer] ComfyUI resources released free_memory=${freeMemory}`);
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
export async function editMedia(sessionId, assetId, options) {
  let response;
  try {
    response = await api.fetchApi(`${PREFIX}/media/${encodeURIComponent(assetId)}/edit`, {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({session_id:sessionId,...options}),
    });
  } catch (error) {
    throw networkError(error);
  }
  if (["download", "audio"].includes(options.action) && response.ok) return response.blob();
  return readApiResponse(response);
}
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
