import { messageText } from "./i18n.js";

export function writeStatusContent(status, snapshot = {}) {
  if (!status) return;
  const dots = Math.max(0, Math.min(3, Number(snapshot.dots) || 0));
  status.querySelector("strong").textContent = `${messageText(snapshot.label)}${".".repeat(dots)}`;
  status.querySelector("[data-status-detail]").textContent = messageText(snapshot.detail);
}
