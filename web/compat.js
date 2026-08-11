const REPLACED_LISTENERS = new WeakMap();

export function createSessionId(cryptoObject = globalThis.crypto) {
  if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID();
  if (typeof cryptoObject?.getRandomValues !== "function") {
    throw new Error("Secure random values are unavailable in this browser context.");
  }

  const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function replaceEventListener(target, type, key, listener, options) {
  let listeners = REPLACED_LISTENERS.get(target);
  if (!listeners) {
    listeners = new Map();
    REPLACED_LISTENERS.set(target, listeners);
  }

  const slot = `${type}:${key}`;
  const previous = listeners.get(slot);
  if (previous) target.removeEventListener(type, previous.listener, previous.options);
  target.addEventListener(type, listener, options);
  listeners.set(slot, { listener, options });
}

export function moveOntoTarget(items, sourceId, targetId, getId = (item) => item.id) {
  const sourceIndex = items.findIndex((item) => getId(item) === sourceId);
  const targetIndex = items.findIndex((item) => getId(item) === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...items];
  const reordered = [...items];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  return reordered;
}

export function isRuntimeMenuInteraction(target) {
  return Boolean(target?.closest?.("[data-runtime-toggle], [data-runtime-menu]"));
}

export function isChoiceMenuInteraction(target) {
  return Boolean(target?.closest?.("[data-choice-toggle], [data-choice-menu]"));
}

export function isGuideMenuInteraction(target) {
  return Boolean(target?.closest?.("[data-guide-toggle], [data-guide-menu]"));
}
