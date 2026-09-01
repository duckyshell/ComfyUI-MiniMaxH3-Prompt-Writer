const INSTALL_KEY = Symbol.for("minimax.h3.prompt.studio.vramHandoff");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const AUTO_VRAM_TOOLTIP = "Automatically manages VRAM when switching between Prompt Writer and ComfyUI, so you don't need to free or unload models manually. Works with Direct GGUF and local Ollama.";

export function autoVramControlMarkup(supported) {
  if (!supported) return "";
  return `<label class="h3ps-toggle-control" data-vram-handoff-control title="${AUTO_VRAM_TOOLTIP}" hidden><input type="checkbox" data-vram-handoff><span></span>Auto VRAM</label>`;
}

export function isLocalOllamaHost(value) {
  try {
    const url = new URL(value || "http://127.0.0.1:11434");
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

export function writerResidencyTargets(status, ollamaHost = null) {
  const residency = status?.prompt_residency;
  const targets = [];
  if (residency?.direct?.loaded) targets.push({ family: "gguf", model_id: residency.direct.model_id || null });
  const reportedTargets = Array.isArray(residency?.ollama?.targets)
    ? residency.ollama.targets
    : (Array.isArray(residency?.ollama?.models) ? residency.ollama.models.map((modelId) => ({ model_id: modelId, endpoint: ollamaHost })) : []);
  const seen = new Set();
  reportedTargets.forEach((target) => {
    const modelId = target?.model_id;
    const endpoint = target?.endpoint || ollamaHost;
    const key = `${endpoint || ""}\n${modelId || ""}`;
    if (!modelId || !isLocalOllamaHost(endpoint) || seen.has(key)) return;
    seen.add(key);
    targets.push({ family: "ollama", model_id: modelId, ollama_host: endpoint });
  });
  return targets;
}

function targetIsResident(status, target) {
  const residency = status?.prompt_residency;
  if (target.family === "gguf") {
    if (!residency?.direct?.loaded) return false;
    return !target.model_id || residency.direct.model_id === target.model_id;
  }
  const reportedTargets = Array.isArray(residency?.ollama?.targets) ? residency.ollama.targets : null;
  if (reportedTargets) {
    return reportedTargets.some((resident) => resident?.model_id === target.model_id
      && (resident?.endpoint || "") === (target.ollama_host || ""));
  }
  return Array.isArray(residency?.ollama?.models) && residency.ollama.models.includes(target.model_id);
}

function handoffError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function comfyQueueIsBusy(status) {
  const comfyui = status?.comfyui;
  return Number(comfyui?.queue_running || 0) > 0 || Number(comfyui?.queue_pending || 0) > 0;
}

export async function releaseComfyVramWhenIdle({
  getStatus,
  freeComfyVram,
  ollamaHost = null,
  isCurrent = () => true,
  onStatus = null,
  pollIntervalMs = 500,
  maxPolls = 40,
  stableToleranceMb = 64,
  sleep = wait,
}) {
  let status = await getStatus(ollamaHost);
  onStatus?.(status);
  if (!isCurrent()) throw handoffError("WRITER_PREPARATION_CANCELLED", "Writer preparation was superseded by ComfyUI Queue.");
  if (status?.comfyui?.available !== true) throw handoffError("COMFYUI_STATE_UNAVAILABLE", "ComfyUI memory state could not be confirmed.");
  if (comfyQueueIsBusy(status)) throw handoffError("COMFYUI_BUSY", "ComfyUI is busy. Wait for the workflow queue to finish.");

  await freeComfyVram();
  if (!isCurrent()) throw handoffError("WRITER_PREPARATION_CANCELLED", "Writer preparation was superseded by ComfyUI Queue.");

  let previousFreeMb = null;
  let stableSamples = 0;
  for (let attempt = 0; attempt <= maxPolls; attempt += 1) {
    status = await getStatus(ollamaHost);
    onStatus?.(status);
    if (!isCurrent()) throw handoffError("WRITER_PREPARATION_CANCELLED", "Writer preparation was superseded by ComfyUI Queue.");
    if (status?.comfyui?.available !== true) throw handoffError("COMFYUI_STATE_UNAVAILABLE", "ComfyUI memory state could not be confirmed.");
    if (comfyQueueIsBusy(status)) throw handoffError("COMFYUI_BECAME_BUSY", "ComfyUI Queue started while VRAM was being prepared. Writer generation did not start.");

    if (status.comfyui.loaded_models === 0) {
      const freeMb = Number(status?.gpu_memory?.free_mb);
      const memoryStable = !Number.isFinite(freeMb)
        || (Number.isFinite(previousFreeMb) && Math.abs(freeMb - previousFreeMb) <= stableToleranceMb);
      stableSamples = memoryStable ? stableSamples + 1 : 1;
      previousFreeMb = Number.isFinite(freeMb) ? freeMb : null;
      if (stableSamples >= 2) return status;
    } else {
      previousFreeMb = null;
      stableSamples = 0;
    }
    if (attempt < maxPolls) await sleep(pollIntervalMs);
  }
  throw handoffError("COMFYUI_RELEASE_TIMEOUT", "ComfyUI did not confirm that workflow models released VRAM. Writer generation did not start.");
}

export async function unloadWriterModels({
  getStatus,
  unloadModel,
  ollamaHost = null,
  onStatus = null,
  pollIntervalMs = 250,
  maxPolls = 60,
  sleep = wait,
}) {
  let status = await getStatus(ollamaHost);
  onStatus?.(status);
  const targets = writerResidencyTargets(status, ollamaHost);
  for (const target of targets) {
    const result = await unloadModel(target);
    if (result?.unload_requested === false) throw handoffError("WRITER_UNLOAD_FAILED", "Prompt Writer could not unload its local model.");
  }
  if (!targets.length) return [];

  for (let attempt = 0; attempt <= maxPolls; attempt += 1) {
    status = await getStatus(ollamaHost);
    onStatus?.(status);
    if (!targets.some((target) => targetIsResident(status, target))) return targets;
    if (attempt < maxPolls) await sleep(pollIntervalMs);
  }
  throw handoffError("WRITER_UNLOAD_TIMEOUT", "Prompt Writer models are still using VRAM. The workflow was not queued.");
}

export function createVramHandoffCoordinator() {
  let writerEpoch = 0;
  let writerRequest = null;
  let queueHandoffActive = false;
  return {
    beginWriterAttempt() {
      writerEpoch += 1;
      return writerEpoch;
    },
    invalidateWriterAttempts() {
      writerEpoch += 1;
      queueHandoffActive = true;
    },
    finishQueueHandoff() {
      queueHandoffActive = false;
    },
    isWriterAttemptCurrent(token) {
      return !queueHandoffActive && token === writerEpoch;
    },
    trackWriterRequest(request) {
      const tracked = Promise.resolve(request).finally(() => {
        if (writerRequest === tracked) writerRequest = null;
      });
      writerRequest = tracked;
      return tracked;
    },
    activeWriterRequest() {
      return writerRequest;
    },
  };
}

export function installVramHandoff(app, handlers) {
  if (typeof app?.queuePrompt !== "function") return false;
  if (app[INSTALL_KEY]) {
    app[INSTALL_KEY].handlers = handlers;
    return true;
  }

  const state = { handlers, original: app.queuePrompt, inFlight: null };
  state.wrapper = async function vramHandoffQueue(...args) {
    if (!state.handlers.isEnabled()) return state.original.apply(this, args);
    state.handlers.onQueueRequested?.();
    if (!state.inFlight) {
      const handoff = Promise.resolve()
        .then(() => state.handlers.beforeQueue())
        .then(() => true, (error) => {
          state.handlers.onError(error);
          return false;
        });
      state.inFlight = handoff.finally(() => {
        state.inFlight = null;
        state.handlers.onQueueHandoffEnd?.();
      });
    }
    if (!await state.inFlight) return false;
    return state.original.apply(this, args);
  };
  app[INSTALL_KEY] = state;
  app.queuePrompt = state.wrapper;
  return true;
}
