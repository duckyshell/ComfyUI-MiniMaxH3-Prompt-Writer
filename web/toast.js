import { messageText } from "./i18n.js";

export function writeToastContent(toast, snapshot = {}) {
  if (!toast) return;
  toast.querySelector("[data-toast-title]").textContent = messageText(snapshot.title);
  toast.querySelector("[data-toast-message]").textContent = messageText(snapshot.message);
  const details = toast.querySelector("[data-toast-details]");
  const technical = snapshot.details == null
    ? ""
    : typeof snapshot.details === "string"
      ? snapshot.details
      : JSON.stringify(snapshot.details, null, 2);
  details.hidden = snapshot.details == null;
  details.querySelector("pre").textContent = technical;
  const action = toast.querySelector("[data-toast-action]");
  action.hidden = !snapshot.action;
  action.textContent = messageText(snapshot.action?.label);
}
