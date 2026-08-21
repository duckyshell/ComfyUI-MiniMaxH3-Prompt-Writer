function fallbackMessage(response, invalidSuccess = false) {
  const status = Number.isInteger(response?.status) ? ` (${response.status})` : "";
  if (invalidSuccess) {
    return `H3 Prompt Writer returned an invalid response${status}. ComfyUI may still be restarting.`;
  }
  return `H3 Prompt Writer request failed${status}. The server returned a non-JSON response.`;
}

export async function readApiResponse(response) {
  const text = await response.text();
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
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  if (payload === null) {
    throw new Error(fallbackMessage(response, true));
  }
  return payload;
}
