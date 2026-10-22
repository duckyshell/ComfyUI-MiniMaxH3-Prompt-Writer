function fallbackMessage(response, invalidSuccess = false) {
  const status = Number.isInteger(response?.status) ? ` (${response.status})` : "";
  if (invalidSuccess) {
    return `H3 Prompt Writer returned an invalid response${status}. ComfyUI may still be restarting.`;
  }
  return `H3 Prompt Writer request failed${status}. The server returned a non-JSON response.`;
}

export function networkError(error) {
  const wrapped = new Error(error?.message || "Network request failed");
  wrapped.code = error?.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "NETWORK_ERROR";
  wrapped.cause = error;
  return wrapped;
}

export async function readApiResponse(response) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw networkError(error);
  }
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || fallbackMessage(response));
    error.code = payload?.error?.code || "REQUEST_FAILED";
    error.details = payload?.error?.details;
    throw error;
  }
  if (payload === null) {
    const error = new Error(fallbackMessage(response, true));
    error.code = "INVALID_RESPONSE";
    throw error;
  }
  return payload;
}
