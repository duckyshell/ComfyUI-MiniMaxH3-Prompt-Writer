import { api } from "/scripts/api.js";

const PREFIX = "/h3studio";

async function request(path, options) {
  const response = await api.fetchApi(`${PREFIX}${path}`, options);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `H3 Prompt Writer request failed (${response.status})`);
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

function post(path, body = {}) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const getStatus = () => request("/status");
export const getModels = () => request("/models");
export const diagnoseGGUFRuntime = (refresh = false) => post("/runtime/gguf/diagnostics", { refresh });
export const probeExternalServer = (payload) => post("/external-server/probe", payload);
export const getOllamaStatus = () => request("/ollama/status");
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
export const unloadModel = () => post("/unload");
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

export function uploadMedia(sessionId, mode, files) {
  const body = new FormData();
  body.append("session_id", sessionId);
  body.append("mode", mode);
  for (const file of files) body.append("file", file);
  return request("/media/upload", { method: "POST", body });
}

export const listMedia = (sessionId) => request(`/media?session_id=${encodeURIComponent(sessionId)}`);
export const removeMedia = (sessionId, assetId) => request(
  `/media/${encodeURIComponent(assetId)}?session_id=${encodeURIComponent(sessionId)}`,
  { method: "DELETE" },
);
export const clearMedia = (sessionId) => request(
  `/media?session_id=${encodeURIComponent(sessionId)}`,
  { method: "DELETE" },
);
export const resampleMedia = (sessionId, assetId, options = {}) => post(
  `/media/${encodeURIComponent(assetId)}/resample`,
  { session_id: sessionId, ...options },
);
export const setMediaAnalysis = (sessionId, assetId, enabled) => post(
  `/media/${encodeURIComponent(assetId)}/analysis`,
  { session_id: sessionId, enabled },
);
export const reorderMedia = (sessionId, mode, assetIds) => post(
  "/media/reorder",
  { session_id: sessionId, mode, asset_ids: assetIds },
);
export const getMediaManifest = (sessionId, mode) => request(
  `/media/manifest?session_id=${encodeURIComponent(sessionId)}&mode=${encodeURIComponent(mode)}`,
);
