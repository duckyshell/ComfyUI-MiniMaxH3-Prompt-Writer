// Browser-like prompt tabs and the background prompt queue for the H3 Video workspace.
// Each tab owns its own media session and per-mode drafts. The active tab's live values
// stay in the Writer state; main.js captures them on switch and applies the next tab.

export const TABS_STORAGE_KEY = "h3ps.promptTabs.v1";
export const MAX_TABS = 20;
const VIDEO_MODES = ["T2VA", "I2VA", "FL2VA", "L2VA", "Reference"];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function blankModeDrafts() {
  return Object.fromEntries(VIDEO_MODES.map((mode) => [mode, { brief: "", prompt: "" }]));
}

export function videoModeDrafts(drafts) {
  return Object.fromEntries(VIDEO_MODES.flatMap((mode) => {
    const draft = drafts?.[mode];
    return draft && typeof draft.brief === "string" && typeof draft.prompt === "string" ? [[mode, { brief: draft.brief, prompt: draft.prompt }]] : [];
  }));
}

export function tabLabel(tab, brief = tab.modeDrafts?.[tab.mode]?.brief) {
  if (tab.name) return tab.name;
  const text = String(brief || "").trim().replace(/\s+/g, " ");
  if (!text) return "New prompt";
  return text.length > 26 ? `${text.slice(0, 25).trimEnd()}…` : text;
}

export function loadTabs(storage) {
  try {
    const value = JSON.parse(storage?.getItem(TABS_STORAGE_KEY) || "null");
    if (value?.version !== 1 || !Array.isArray(value.tabs)) return null;
    const tabs = value.tabs.filter((tab) => tab && typeof tab.id === "string" && typeof tab.sessionId === "string" && VIDEO_MODES.includes(tab.mode))
      .slice(0, MAX_TABS)
      .map((tab) => ({
        id: tab.id,
        name: typeof tab.name === "string" && tab.name.trim() ? tab.name.trim().slice(0, 60) : null,
        mode: tab.mode,
        modeDrafts: videoModeDrafts(tab.modeDrafts),
        sessionId: tab.sessionId,
        durationSeconds: Number.isInteger(tab.durationSeconds) ? tab.durationSeconds : 10,
        aspectRatio: typeof tab.aspectRatio === "string" ? tab.aspectRatio : "16:9",
        assets: null,
        status: "idle",
      }));
    if (!tabs.length) return null;
    return { tabs, activeId: tabs.some((tab) => tab.id === value.activeId) ? value.activeId : tabs[0].id };
  } catch {
    return null;
  }
}

export function saveTabs(storage, { tabs, activeId }) {
  storage?.setItem(TABS_STORAGE_KEY, JSON.stringify({
    version: 1,
    activeId,
    tabs: tabs.map(({ id, name, mode, modeDrafts, sessionId, durationSeconds, aspectRatio }) => ({ id, name, mode, modeDrafts, sessionId, durationSeconds, aspectRatio })),
  }));
}

export function tabsBarMarkup() {
  return `<div class="h3ps-tabs" data-prompt-tabs><div class="h3ps-tabs-strip" role="tablist" aria-label="Prompt tabs" data-tabs-strip></div><button type="button" class="h3ps-tab-add" data-tab-add aria-label="New tab" title="New tab"></button><div class="h3ps-tabs-queue" data-queue-summary hidden></div></div>`;
}

export function createPromptTabs({ root, icon, storage, newId, initial, getActive, capture, apply, canSwitch, onChange, onRender, notify }) {
  const bar = root.querySelector("[data-prompt-tabs]");
  const strip = bar.querySelector("[data-tabs-strip]");
  const addButton = bar.querySelector("[data-tab-add]");
  addButton.innerHTML = icon("plus", 14);
  const summary = bar.querySelector("[data-queue-summary]");
  const restored = loadTabs(storage);
  let tabs = restored?.tabs || [{ id: newId(), name: null, assets: [], status: "idle", ...initial }];
  let activeId = restored?.activeId || tabs[0].id;
  let queueCounter = 0;
  let renaming = null;
  if (restored) {
    // The Writer's own drafts and preferences are the newest copy of the active tab.
    const active = tabs.find((tab) => tab.id === activeId);
    Object.assign(active, { ...initial, sessionId: active.sessionId, assets: null });
  }

  const find = (id) => tabs.find((tab) => tab.id === id);
  const active = () => find(activeId);
  const queued = () => tabs.filter((tab) => tab.status === "queued").sort((a, b) => a.queuedAt - b.queuedAt);
  const running = () => tabs.find((tab) => tab.status === "running") || null;
  const save = () => saveTabs(storage, { tabs, activeId });

  function statusMarkup(tab) {
    if (tab.status === "running") return `<span class="h3ps-tab-status is-running" title="Generating"><span class="h3ps-spinner"></span></span>`;
    if (tab.status === "queued") return `<span class="h3ps-tab-status is-queued" title="Queued">${queued().indexOf(tab) + 1}</span>`;
    if (tab.status === "done") return `<span class="h3ps-tab-status is-done" title="Prompt ready">${icon("check", 11)}</span>`;
    if (tab.status === "error") return `<span class="h3ps-tab-status is-error" title="${escapeHtml(tab.error || "Generation failed")}">!</span>`;
    return "";
  }

  function render() {
    const disabled = Boolean(canSwitch());
    const scrollLeft = strip.scrollLeft;
    strip.innerHTML = tabs.map((tab) => {
      const isActive = tab.id === activeId;
      const live = isActive ? getActive() : null;
      const mode = live?.mode || tab.mode;
      const label = tabLabel(tab, live ? live.brief : undefined);
      const labelMarkup = renaming === tab.id
        ? `<input class="h3ps-tab-rename" data-tab-rename="${tab.id}" value="${escapeHtml(tab.name || label)}" maxlength="60" aria-label="Tab name">`
        : `<span class="h3ps-tab-label">${escapeHtml(label)}</span>`;
      return `<div class="h3ps-tab${isActive ? " is-active" : ""} is-${tab.status}" data-tab="${tab.id}">
        <button type="button" role="tab" class="h3ps-tab-select" aria-selected="${isActive}" data-tab-select="${tab.id}" title="${escapeHtml(`${label} · ${mode}${isActive ? ". Double-click to rename." : ""}`)}" ${disabled && !isActive ? "disabled" : ""}>
          ${statusMarkup(tab)}<span class="h3ps-tab-mode">${mode}</span>${labelMarkup}
        </button>
        ${tabs.length > 1 ? `<button type="button" class="h3ps-tab-close" data-tab-close="${tab.id}" aria-label="Close ${escapeHtml(label)}" title="Close tab" ${disabled || tab.status === "running" ? "disabled" : ""}>${icon("close", 11)}</button>` : ""}
      </div>`;
    }).join("");
    addButton.disabled = disabled || tabs.length >= MAX_TABS;
    strip.scrollLeft = scrollLeft;
    const activeTab = strip.querySelector(".h3ps-tab.is-active");
    if (activeTab) {
      // Keep the active tab, including its close button, inside the visible strip.
      const view = strip.getBoundingClientRect();
      const box = activeTab.getBoundingClientRect();
      if (box.left < view.left) strip.scrollLeft -= view.left - box.left;
      else if (box.right > view.right) strip.scrollLeft += box.right - view.right;
    }
    const waiting = queued().length;
    const current = running();
    summary.hidden = !waiting && !current;
    summary.innerHTML = summary.hidden ? "" : `<span><strong>Queue</strong>${current ? " · 1 generating" : ""}${waiting ? ` · ${waiting} waiting` : ""}</span><button type="button" class="h3ps-text-button" data-queue-stop>Stop queue</button>`;
    const input = strip.querySelector("[data-tab-rename]");
    if (input) { input.focus(); input.select(); }
    onRender?.();
  }

  async function select(id) {
    const tab = find(id);
    if (!tab || id === activeId) return false;
    const reason = canSwitch();
    if (reason) { notify("Tabs are locked", reason); return false; }
    Object.assign(active(), capture());
    activeId = id;
    if (tab.status === "done" || tab.status === "error") { tab.status = "idle"; tab.error = null; }
    render();
    save();
    await apply(tab);
    return true;
  }

  function add() {
    if (tabs.length >= MAX_TABS || canSwitch()) return null;
    const current = capture();
    const tab = {
      id: newId(), name: null, mode: current.mode, modeDrafts: blankModeDrafts(), sessionId: newId(), assets: [],
      durationSeconds: current.durationSeconds, aspectRatio: current.aspectRatio, status: "idle",
    };
    tabs.splice(tabs.indexOf(active()) + 1, 0, tab);
    select(tab.id);
    return tab;
  }

  function close(id) {
    const tab = find(id);
    if (!tab || tabs.length < 2 || tab.status === "running" || canSwitch()) return;
    const index = tabs.indexOf(tab);
    const wasActive = id === activeId;
    if (wasActive) Object.assign(tab, capture());
    tab.status = "idle";
    tabs = tabs.filter((item) => item !== tab);
    if (wasActive) {
      const next = tabs[Math.min(index, tabs.length - 1)];
      activeId = next.id;
      if (next.status === "done" || next.status === "error") next.status = "idle";
      apply(next);
    }
    render();
    save();
    onChange();
    notify("Tab closed", tabLabel(tab), {
      label: "Undo",
      onClick: () => {
        if (tabs.length >= MAX_TABS || find(tab.id)) return;
        tabs.splice(Math.min(index, tabs.length), 0, tab);
        if (wasActive) select(tab.id);
        else { render(); save(); }
      },
    });
  }

  function enqueue(id = activeId) {
    const tab = find(id);
    if (!tab || tab.status === "running" || tab.status === "queued") return false;
    if (id === activeId) Object.assign(tab, capture());
    Object.assign(tab, { status: "queued", queuedAt: ++queueCounter, error: null });
    render();
    onChange();
    return true;
  }

  function dequeue(id = activeId) {
    const tab = find(id);
    if (tab?.status !== "queued") return false;
    tab.status = "idle";
    render();
    onChange();
    return true;
  }

  function finishRename(input, commit) {
    const tab = find(input.dataset.tabRename);
    renaming = null;
    if (tab && commit) {
      const value = input.value.trim().slice(0, 60);
      tab.name = value && value !== tabLabel({ ...tab, name: null }, tab.id === activeId ? getActive().brief : undefined) ? value : null;
      save();
    }
    render();
  }

  strip.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-tab-close]");
    if (closeButton) { close(closeButton.dataset.tabClose); return; }
    if (event.target.closest("[data-tab-rename]")) return;
    const tabButton = event.target.closest("[data-tab-select]");
    if (tabButton) select(tabButton.dataset.tabSelect);
  });
  addButton.addEventListener("click", add);
  strip.addEventListener("wheel", (event) => {
    if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  }, { passive: false });
  strip.addEventListener("auxclick", (event) => {
    const tab = event.button === 1 && event.target.closest("[data-tab]");
    if (tab) { event.preventDefault(); close(tab.dataset.tab); }
  });
  strip.addEventListener("dblclick", (event) => {
    const tabButton = event.target.closest("[data-tab-select]");
    if (!tabButton || tabButton.dataset.tabSelect !== activeId) return;
    renaming = activeId;
    render();
  });
  strip.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-tab-rename]");
    if (!input) return;
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); finishRename(input, true); }
    if (event.key === "Escape") { event.preventDefault(); finishRename(input, false); }
  });
  strip.addEventListener("focusout", (event) => {
    const input = event.target.closest("[data-tab-rename]");
    if (input && renaming) finishRename(input, true);
  });
  summary.addEventListener("click", (event) => {
    if (!event.target.closest("[data-queue-stop]")) return;
    queued().forEach((tab) => { tab.status = "idle"; });
    render();
    onChange({ stop: true });
  });
  root.addEventListener("input", (event) => {
    if (event.target.matches("[data-video-brief]") && !active().name) render();
  });

  render();
  save();

  return {
    get tabs() { return tabs; },
    get active() { return active(); },
    get running() { return running(); },
    get queued() { return queued(); },
    find,
    select,
    add,
    close,
    enqueue,
    dequeue,
    render,
    save,
    setStatus(id, status, error = null) {
      const tab = find(id);
      if (!tab) return;
      Object.assign(tab, { status, error });
      render();
    },
  };
}
