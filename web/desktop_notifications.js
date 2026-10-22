import { t } from "./i18n.js";

const KEY = "h3-writer-desktop-notifications";

export function createDesktopNotifications({ storage, document, window }) {
  const API = window.Notification;
  let enabled = false;
  try { enabled = storage.getItem(KEY) === "true"; } catch {}
  const supported = () => Boolean(API && window.isSecureContext);
  return {
    get enabled() { return enabled && supported() && API.permission === "granted"; },
    get hint() {
      if (!supported()) return t("notifications.unavailable");
      if (API.permission === "denied") return t("notifications.blocked");
      return t("notifications.hint");
    },
    async setEnabled(value) {
      enabled = false;
      if (value && supported()) {
        try {
          const permission = API.permission === "default" ? await API.requestPermission() : API.permission;
          enabled = permission === "granted";
        } catch {}
      }
      try { storage.setItem(KEY, String(enabled)); } catch {}
    },
    notify(title) {
      if (!this.enabled || document.visibilityState !== "hidden") return;
      try {
        const notification = new API("H3 Prompt Writer", { body: title, tag: "h3-writer-generation" });
        notification.onclick = () => { try { window.focus(); } finally { notification.close(); } };
      } catch {}
    },
  };
}
