import { onLocaleChange, t, translateDom } from "./i18n.js";
import { clampPanelPosition, workflowMediaSnapshot } from "./workflow_media.js";

const DRAG_TYPE = "application/x-h3ps-workflow-media";
const POSITION_KEY = "h3ps-floating-media-position";

export function createFloatingMediaPanel({ app, getState, transfer, icon, openWriter, storage = localStorage }) {
  const root = document.createElement("section");
  root.className = "h3ps-root h3ps-media-float";
  root.setAttribute("aria-label", t("media.float.aria"));
  root.innerHTML = `<header class="h3ps-float-header" tabindex="0" aria-label="${t("media.float.move")}" data-i18n-aria-label="media.float.move">
    <strong data-i18n="media.float.title">${t("media.float.title")}</strong><span></span>
    <button type="button" class="h3ps-icon-button" data-float-writer title="${t("media.float.open")}" data-i18n-title="media.float.open" aria-label="${t("media.float.open")}" data-i18n-aria-label="media.float.open">${icon("expand", 15)}</button>
    <button type="button" class="h3ps-icon-button" data-float-close title="${t("media.float.close")}" data-i18n-title="media.float.close" aria-label="${t("media.float.close")}" data-i18n-aria-label="media.float.close">${icon("close", 15)}</button>
  </header><p class="h3ps-float-hint" data-i18n="media.float.hint">${t("media.float.hint")}</p>
  <div class="h3ps-assets h3ps-float-assets"></div>
  <p class="h3ps-float-status" role="status" aria-live="polite"></p>`;
  document.body.appendChild(root);
  const header = root.querySelector("header"), cards = root.querySelector(".h3ps-assets");
  const status = root.querySelector("[role=status]");
  let opened = false, suspended = false, move = null, dragging = null, pending = null, signature = "";
  let position = { x: 24, y: 100 }, events = null;
  try { position = JSON.parse(storage.getItem(POSITION_KEY)) || position; } catch {}
  function place(next = position) {
    position = clampPanelPosition(next, { width: innerWidth, height: innerHeight },
      { width: root.offsetWidth, height: root.offsetHeight });
    root.style.left = position.x + "px"; root.style.top = position.y + "px";
  }
  function savePosition() { try { storage.setItem(POSITION_KEY, JSON.stringify(position)); } catch {} }
  let statusKey = "media.float.status", statusParams = {}, statusRaw = "";
  function renderStatus() { status.textContent = statusRaw || t(statusKey, statusParams); }
  function notice(key, params = {}) { statusKey = key; statusParams = params; statusRaw = ""; renderStatus(); }
  function noticeFailure(message) { statusKey = "media.float.failed"; statusParams = {}; statusRaw = message ? String(message) : ""; renderStatus(); }
  function cancelTransfer() { dragging = null; pending?.abort(); pending = null; move = null; }
  function isOurDrag(event) {
    return !!dragging && Array.from(event.dataTransfer?.types || []).includes(DRAG_TYPE);
  }
  function refresh() {
    const state = getState();
    root.dataset.theme = state.theme;
    root.dataset.interfaceSize = state.interfaceSize;
    const assets = state.assets.filter(workflowMediaSnapshot);
    const key = JSON.stringify(assets.map(a => [a.id, a.reference, a.status, a.filename, a.content_url, a.preview_url]));
    if (key === signature) { if (opened && !suspended) place(); return; }
    signature = key;
    cards.replaceChildren();
    for (const asset of assets) {
      const card = document.createElement("div");
      card.className = "h3ps-asset"; card.tabIndex = 0; card.draggable = true; card.dataset.floatAsset = asset.id;
      const typeKey = ["image", "video", "audio"].includes(asset.type) ? `media.type.${asset.type}` : "";
      const title = asset.reference || (asset.status === "needs_edit" ? t("media.trim_required") : typeKey ? t(typeKey) : asset.type);
      card.title = `${title} · ${asset.filename}\n${t("media.float.drag_hint")}`;
      const preview = document.createElement("div"); preview.className = "h3ps-asset-preview";
      if (asset.preview_url && asset.type !== "audio") {
        const image = document.createElement("img"); image.className = "h3ps-real-thumb";
        image.src = asset.preview_url; image.alt = ""; image.draggable = false; preview.appendChild(image);
      } else { preview.classList.add("h3ps-float-audio"); preview.innerHTML = icon("audio", 26); }
      const copy = document.createElement("div"); copy.className = "h3ps-asset-copy";
      const label = document.createElement("strong"); label.textContent = title;
      const filename = document.createElement("small"); filename.textContent = asset.filename;
      copy.append(label, filename); card.append(preview, copy); cards.appendChild(card);
    }
    if (!assets.length) {
      const empty = document.createElement("p"); empty.className = "h3ps-float-empty";
      empty.textContent = t("media.float.empty"); cards.appendChild(empty);
    }
    if (opened && !suspended) place();
  }
  function bind() {
    if (events) return;
    events = new AbortController();
    const options = { capture: true, signal: events.signal };
    document.addEventListener("dragover", event => {
      if (!isOurDrag(event)) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      let supported = false;
      try {
        transfer.destination(dragging.snapshot.kind, [event.clientX, event.clientY], event.target);
        supported = true;
      } catch {}
      event.dataTransfer.dropEffect = supported ? "copy" : "none";
    }, options);
    document.addEventListener("drop", async event => {
      if (!isOurDrag(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const snapshot = dragging.snapshot;
      dragging = null;
      const element = event.target;
      const controller = new AbortController(); pending = controller;
      notice("media.float.sending");
      try {
        await transfer.drop(snapshot, [event.clientX, event.clientY], controller.signal, element);
        if (!controller.signal.aborted) notice("media.float.sent");
      } catch (error) {
        if (!controller.signal.aborted) noticeFailure(error.message);
      } finally { if (pending === controller) pending = null; }
    }, options);
    window.addEventListener("resize", () => { place(); savePosition(); }, { signal: events.signal });
  }
  function visibility() {
    const visible = opened && !suspended;
    root.classList.toggle("is-open", visible);
    root.hidden = !visible;
    if (visible) { refresh(); place(); bind(); }
    else { events?.abort(); events = null; cancelTransfer(); }
  }
  root.addEventListener("dragstart", event => {
    const card = event.target.closest("[data-float-asset]");
    const asset = getState().assets.find(a => a.id === card?.dataset.floatAsset);
    const snapshot = workflowMediaSnapshot(asset);
    if (!snapshot || pending) { event.preventDefault(); return; }
    dragging = { snapshot };
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(DRAG_TYPE, snapshot.id);
    event.stopPropagation();
  });
  root.addEventListener("dragend", () => { dragging = null; });
  root.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    // Graph keyboard shortcuts must not delete selected nodes while this panel has focus.
    event.stopPropagation();
  });
  header.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button")) return;
    move = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...position } };
    header.setPointerCapture(event.pointerId); event.preventDefault();
  });
  header.addEventListener("pointermove", event => {
    if (move?.pointer !== event.pointerId) return;
    place({ x: move.origin.x + event.clientX - move.x, y: move.origin.y + event.clientY - move.y });
  });
  const endMove = () => { move = null; savePosition(); };
  header.addEventListener("pointerup", endMove);
  header.addEventListener("pointercancel", endMove);
  header.addEventListener("keydown", event => {
    if (event.target !== header || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 30 : 10;
    place({ x: position.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
      y: position.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) });
    savePosition();
  });
  root.querySelector("[data-float-writer]").addEventListener("click", openWriter);
  root.querySelector("[data-float-close]").addEventListener("click", close);
  function close() { opened = false; visibility(); app.canvas?.canvas?.focus(); }
  renderStatus();
  const offLocale = onLocaleChange(() => {
    root.setAttribute("aria-label", t("media.float.aria"));
    translateDom(root);
    renderStatus();
    signature = "";
    if (opened && !suspended) refresh();
  });
  visibility();
  return {
    open() { opened = true; suspended = false; visibility(); header.focus({ preventScroll: true }); },
    suspend(value) { suspended = value; visibility(); },
    refresh,
    close,
    destroy() { offLocale(); close(); root.remove(); },
  };
}
