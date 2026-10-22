import { api } from "/scripts/api.js";
import { networkError, readApiResponse } from "./response.js";

export async function readSequenceStream(response, onEvent) {
  if (!response.ok) return readApiResponse(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", done = false;
  try {
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "error") throw Object.assign(new Error(event.message), { code: event.code, details: event.details });
        if (event.type === "done") done = true;
        onEvent(event);
      }
      if (part.done) break;
    }
    if (!done || buffer.trim()) {
      const error = new Error("Sequence connection ended before completion. Completed prompts were kept.");
      error.code = "STREAM_INTERRUPTED";
      throw error;
    }
  } finally { reader.releaseLock(); }
}

export async function generateSequence(payload, onEvent) {
  let response;
  try {
    response = await api.fetchApi("/h3studio/sequence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (error) {
    throw networkError(error);
  }
  return readSequenceStream(response, onEvent);
}

export async function cancelSequence(operationId, sessionId) {
  let response;
  try {
    response = await api.fetchApi("/h3studio/sequence/cancel", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({operation_id:operationId,session_id:sessionId}),
    });
  } catch (error) {
    throw networkError(error);
  }
  return readApiResponse(response);
}
