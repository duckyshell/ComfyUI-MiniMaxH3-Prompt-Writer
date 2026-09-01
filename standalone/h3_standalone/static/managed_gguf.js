const PANEL = '[data-provider-panel="direct"]';
const RELEASES_URL = "https://github.com/ggml-org/llama.cpp/releases";
let currentState = null;
let refreshPending = null;

async function hostRequest(path, body = null) {
  const options = body === null
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Standalone host returned ${response.status}.`);
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function currentModelPath() {
  return document.querySelector("[data-installed-model]")?.value || currentState?.config?.selected_model || "";
}

function fileInfo(state, path) {
  if (!path) return null;
  return (state.discovery?.files || []).find((item) => item.path === path) || null;
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function selectedPair(state) {
  const modelPath = state.config?.selected_model || currentModelPath();
  const projectorPath = state.config?.selected_projector || "";
  return {
    modelPath,
    projectorPath,
    model: fileInfo(state, modelPath),
    projector: fileInfo(state, projectorPath),
  };
}

function metadataMatches(model, projector) {
  const left = String(model?.metadata_name || "").trim().toLocaleLowerCase();
  const right = String(projector?.metadata_name || "").trim().toLocaleLowerCase();
  return Boolean(left && right && left === right);
}

function matchingProjectors(state, model) {
  if (!model?.metadata_name) return [];
  return (state.discovery?.files || []).filter((item) => item.kind === "projector" && metadataMatches(model, item));
}

function matchingModels(state, projector) {
  if (!projector?.metadata_name) return [];
  return (state.discovery?.files || []).filter((item) => ["model", "unknown"].includes(item.kind) && metadataMatches(item, projector));
}

function decorateModelOptions(state) {
  const select = document.querySelector("[data-installed-model]");
  if (!select) return;
  for (const option of select.options) {
    const model = fileInfo(state, option.value);
    if (!model) continue;
    const selected = option.value.toLocaleLowerCase() === String(state.config?.selected_model || "").toLocaleLowerCase();
    const projectorSelected = selected && Boolean(state.config?.selected_projector);
    const matches = matchingProjectors(state, model);
    const capability = projectorSelected || (!selected && matches.length === 1)
      ? "Vision"
      : matches.length > 1 ? "Choose vision" : "Text only";
    const base = option.textContent
      .replace(/ · (Vision|Choose vision|Text only)$/u, "")
      .replace(/ · Text only$/u, "");
    const next = `${base} · ${capability}`;
    if (option.textContent !== next) option.textContent = next;
  }
}

function clearError() {
  const target = document.querySelector(`${PANEL} [data-lite-error]`);
  if (target) {
    target.hidden = true;
    target.textContent = "";
  }
}

function showError(error) {
  const target = document.querySelector(`${PANEL} [data-lite-error]`);
  if (!target) return;
  target.hidden = false;
  target.textContent = error?.message || String(error);
}

async function saveConfig(values, { refreshModels = false } = {}) {
  clearError();
  await hostRequest("/standalone/gguf/config", values);
  await refresh({ force: true });
  if (refreshModels) {
    document.querySelector("[data-model-refresh]")?.click();
    setTimeout(() => refresh({ force: true }), 250);
  }
}

async function browse(kind) {
  const result = await hostRequest("/standalone/gguf/browse", { kind });
  return result.path || "";
}

function setBusy(button, busy, label = null) {
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.idleLabel;
}

function actionButton(label, action, className = "") {
  const button = element("button", className, label);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

function closeMenus(except = null) {
  document.querySelectorAll(".h3-lite-add-menu").forEach((menu) => {
    if (menu !== except) menu.hidden = true;
  });
  document.querySelectorAll('[aria-haspopup="menu"]').forEach((button) => {
    if (!except || !button.parentElement?.contains(except)) button.setAttribute("aria-expanded", "false");
  });
}

function toggleMenu(button, menu) {
  const opening = menu.hidden;
  closeMenus(opening ? menu : null);
  menu.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
}

async function refreshModelCatalog({ rescan = false } = {}) {
  const state = await refresh({ force: true, rescan });
  document.querySelector("[data-model-refresh]")?.click();
  setTimeout(() => refresh({ force: true }), 250);
  return state;
}

function renderLocationsMenu(state, button, menu) {
  const roots = state.discovery?.roots || [];
  button.textContent = `Locations · ${roots.length}`;
  button.title = `${roots.length} model location${roots.length === 1 ? "" : "s"}`;
  menu.replaceChildren();

  const heading = element("span", "h3-lite-menu-heading");
  heading.append(
    element("strong", null, "Model locations"),
    element("small", null, "All folders are combined into one model list."),
  );
  menu.append(heading);

  const locations = element("span", "h3-lite-location-list");
  if (!roots.length) {
    locations.append(element("span", "h3-lite-empty-location", "No model folders are remembered."));
  }
  for (const root of roots) {
    const row = element("span", "h3-lite-location-row");
    const copy = element("span", "h3-lite-location-copy");
    copy.title = root.path;
    copy.append(
      element("strong", null, fileName(root.path) || root.path),
      element("small", null, `${root.files || 0} GGUF file${root.files === 1 ? "" : "s"} · ${root.path}`),
    );
    const forget = actionButton("Forget", async () => {
      setBusy(forget, true, "Forgetting…");
      try {
        await hostRequest("/standalone/gguf/roots/remove", { path: root.path });
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
        await refreshModelCatalog({ rescan: true });
      } catch (error) { showError(error); }
      finally { setBusy(forget, false); }
    });
    row.append(copy, forget);
    locations.append(row);
  }
  menu.append(locations);

  if (roots.length) {
    const forgetAll = actionButton("Forget all locations", async () => {
      setBusy(forgetAll, true, "Forgetting…");
      try {
        await hostRequest("/standalone/gguf/roots/clear", {});
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
        await refreshModelCatalog({ rescan: true });
      } catch (error) { showError(error); }
      finally { setBusy(forgetAll, false); }
    }, "is-danger h3-lite-menu-footer");
    menu.append(forgetAll);
  }
}

function syncModelControls(state) {
  const panel = document.querySelector(PANEL);
  const heading = panel?.querySelector(".h3ps-settings-section-heading");
  if (!heading) return;
  heading.querySelector("small")?.replaceChildren("Model");
  heading.querySelector("strong")?.replaceChildren("Local GGUF models");

  let actions = heading.querySelector("[data-lite-model-actions]");
  if (!actions) {
    actions = element("span", "h3-lite-heading-actions");
    actions.dataset.liteModelActions = "true";
    const addControl = element("span", "h3-lite-add-control");
    const add = actionButton("Add models…", () => toggleMenu(add, menu));
    add.setAttribute("aria-haspopup", "menu");
    add.setAttribute("aria-expanded", "false");
    const menu = element("span", "h3-lite-add-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    const addFile = actionButton("Choose one model GGUF…", async () => {
      menu.hidden = true;
      setBusy(add, true, "Choosing…");
      try {
        const path = await browse("model");
        if (path) await saveConfig({ selected_model: path }, { refreshModels: true });
      } catch (error) { showError(error); }
      finally { setBusy(add, false); }
    });
    const addFolder = actionButton("Scan a folder of GGUFs…", async () => {
      menu.hidden = true;
      setBusy(add, true, "Choosing…");
      try {
        const path = await browse("folder");
        if (path) {
          await hostRequest("/standalone/gguf/roots/add", { path });
          const state = await refresh({ force: true });
          const firstModel = !state.config?.selected_model
            ? (state.discovery?.files || []).find((item) => ["model", "unknown"].includes(item.kind))
            : null;
          if (firstModel) await saveConfig({ selected_model: firstModel.path }, { refreshModels: true });
          else {
            document.querySelector("[data-model-refresh]")?.click();
            setTimeout(() => refresh({ force: true }), 250);
          }
        }
      } catch (error) { showError(error); }
      finally { setBusy(add, false); }
    });
    menu.append(addFile, addFolder);
    addControl.append(add, menu);

    const locationsControl = element("span", "h3-lite-add-control h3-lite-locations-control");
    const locations = actionButton("Locations · 0", () => toggleMenu(locations, locationsMenu));
    locations.dataset.liteLocationsButton = "true";
    locations.setAttribute("aria-haspopup", "menu");
    locations.setAttribute("aria-expanded", "false");
    const locationsMenu = element("span", "h3-lite-add-menu h3-lite-locations-menu");
    locationsMenu.dataset.liteLocationsMenu = "true";
    locationsMenu.hidden = true;
    locationsMenu.setAttribute("role", "menu");
    locationsControl.append(locations, locationsMenu);
    const refreshButton = heading.querySelector("[data-model-refresh]");
    actions.append(addControl, locationsControl);
    if (refreshButton) actions.append(refreshButton);
    heading.append(actions);
  }

  const locationsButton = actions.querySelector("[data-lite-locations-button]");
  const locationsMenu = actions.querySelector("[data-lite-locations-menu]");
  if (locationsButton && locationsMenu) renderLocationsMenu(state, locationsButton, locationsMenu);

  decorateModelOptions(state);
  const pair = selectedPair(state);
  const modelControl = panel.querySelector(".h3ps-installed-model-control");
  let source = panel.querySelector("[data-lite-model-summary]");
  if (!source && modelControl) {
    source = element("p", "h3ps-installed-model-source h3-lite-model-summary");
    source.dataset.liteModelSummary = "true";
    modelControl.after(source);
  }
  if (source) {
    if (!pair.modelPath) {
      source.textContent = "Choose an existing model GGUF; its folder is remembered automatically.";
      source.title = "";
    } else {
      const family = pair.model?.metadata_name || fileName(pair.modelPath);
      const capability = pair.projectorPath ? "Vision ready" : "Text only";
      const reasoning = pair.model?.reasoning_effort
        ? ` · Thinking ${pair.model.reasoning_effort}`
        : "";
      source.textContent = `${family} · ${capability}${reasoning}`;
      source.title = pair.modelPath;
    }
  }
}

function renderRuntime(container, state) {
  const section = element("section", "h3-lite-section");
  const heading = element("header", "h3ps-settings-section-heading");
  const title = element("span");
  title.append(element("small", null, "Local engine"), element("strong", null, "llama-server"));
  const status = state.runtime?.running
    ? `Running · PID ${state.runtime.pid}`
    : state.server_selected ? "Ready · starts on Generate" : "Not selected";
  heading.append(title, element("em", state.runtime?.running ? "is-running" : "", status));
  section.append(heading);

  const control = element("div", "h3-lite-file-control");
  const copy = element("span", "h3-lite-file-copy");
  const serverPath = state.config?.server_path || "";
  copy.append(
    element("strong", null, serverPath ? fileName(serverPath) : "No llama-server selected"),
    element("small", null, serverPath || "Choose llama-server.exe from an extracted official release"),
  );
  const actions = element("span", "h3-lite-file-actions");
  const chooseRuntime = async (button) => {
    setBusy(button, true, "Choosing…");
    try {
      const path = await browse("server");
      if (path) await saveConfig({ server_path: path }, { refreshModels: true });
    } catch (error) { showError(error); }
    finally { setBusy(button, false); }
  };
  if (serverPath) {
    const manageControl = element("span", "h3-lite-add-control");
    const manage = actionButton("Manage", () => toggleMenu(manage, menu));
    manage.setAttribute("aria-haspopup", "menu");
    manage.setAttribute("aria-expanded", "false");
    const menu = element("span", "h3-lite-add-menu h3-lite-runtime-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.append(
      actionButton("Change llama-server…", () => {
        menu.hidden = true;
        chooseRuntime(manage);
      }),
      actionButton("Forget runtime", async () => {
        menu.hidden = true;
        setBusy(manage, true, "Forgetting…");
        try { await saveConfig({ server_path: "" }, { refreshModels: true }); }
        catch (error) { showError(error); }
        finally { setBusy(manage, false); }
      }, "is-danger"),
    );
    manageControl.append(manage, menu);
    actions.append(manageControl);
  } else {
    const choose = actionButton("Choose…", () => chooseRuntime(choose));
    actions.append(choose);
  }
  if (state.runtime?.running) {
    const stop = actionButton("Stop", async () => {
      setBusy(stop, true, "Stopping…");
      try {
        await hostRequest("/standalone/gguf/stop", {});
        await refresh({ force: true });
      } catch (error) { showError(error); }
      finally { setBusy(stop, false); }
    }, "is-danger");
    actions.append(stop);
  }
  control.append(copy, actions);
  section.append(control);

  const note = element("p", "h3ps-installed-model-source");
  note.append("Starts automatically when you generate. Standalone does not bundle the runtime. ");
  const link = element("a", null, "Get llama.cpp ↗");
  link.href = RELEASES_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  note.append(link);
  section.append(note);
  container.append(section);
}

function renderProjector(container, state) {
  const section = element("section", "h3-lite-section");
  const pair = selectedPair(state);
  const matched = metadataMatches(pair.model, pair.projector);
  const candidates = matchingProjectors(state, pair.model);
  const sharedModels = matchingModels(state, pair.projector);
  const heading = element("header", "h3ps-settings-section-heading");
  const title = element("span");
  title.append(element("small", null, "Vision · optional"), element("strong", null, "Vision projector"));
  const status = !pair.projectorPath
    ? candidates.length > 1 ? `${candidates.length} matches · choose one` : "Text only"
    : matched ? `Matched · ${pair.projector.metadata_name}` : "Selected manually";
  heading.append(title, element("em", pair.projectorPath ? "is-ready" : "", status));
  section.append(heading);

  const control = element("div", "h3-lite-file-control");
  const copy = element("span", "h3-lite-file-copy");
  const description = pair.projectorPath
    ? matched
      ? `GGUF metadata match${sharedModels.length > 1 ? ` · shared by ${sharedModels.length} model variants` : ""}`
      : "Compatibility will be verified when llama-server loads the pair"
    : candidates.length > 1
      ? "Several projectors match this model; choose the one you want to load"
      : "Optional for image and video input";
  copy.append(
    element("strong", null, pair.projectorPath ? fileName(pair.projectorPath) : "No vision projector"),
    element("small", null, description),
  );
  if (pair.projectorPath) copy.title = pair.projectorPath;

  const actions = element("span", "h3-lite-file-actions");
  const choose = actionButton(pair.projectorPath ? "Change" : "Choose…", async () => {
    setBusy(choose, true, "Choosing…");
    try {
      const path = await browse("projector");
      if (path) await saveConfig({ selected_model: pair.modelPath, selected_projector: path }, { refreshModels: true });
    } catch (error) { showError(error); }
    finally { setBusy(choose, false); }
  });
  actions.append(choose);
  if (pair.projectorPath) {
    actions.append(actionButton("Use text only", () => {
      saveConfig({ selected_model: pair.modelPath, selected_projector: "" }, { refreshModels: true }).catch(showError);
    }));
  }
  control.append(copy, actions);
  section.append(control);
  container.append(section);
}

function render(state) {
  currentState = state;
  const panel = document.querySelector(PANEL);
  if (!panel) return;
  syncModelControls(state);
  const old = panel.querySelector("[data-lite-managed-gguf]");
  const container = element("div", "h3-lite-managed");
  container.dataset.liteManagedGguf = "true";
  const error = element("div", "h3-lite-error");
  error.dataset.liteError = "true";
  error.hidden = true;
  container.append(error);
  renderRuntime(container, state);
  renderProjector(container, state);
  if (old) old.replaceWith(container);
  else panel.querySelector("[data-lite-model-summary]")?.after(container);
}

async function refresh({ force = false, rescan = false } = {}) {
  if (refreshPending && !force) return refreshPending;
  refreshPending = hostRequest(`/standalone/gguf/state${rescan ? "?refresh=1" : ""}`)
    .then((state) => {
      render(state);
      return state;
    })
    .catch(showError)
    .finally(() => { refreshPending = null; });
  return refreshPending;
}

function attach() {
  const providerButton = document.querySelector('[data-provider-option="direct"]');
  providerButton?.querySelector("strong")?.replaceChildren("Local GGUF");
  providerButton?.querySelector("small")?.replaceChildren("Existing files via llama-server");
  const externalButton = document.querySelector('[data-provider-option="external"]');
  externalButton?.querySelector("small")?.replaceChildren("Already running local server");

  const panel = document.querySelector(PANEL);
  if (!panel || panel.dataset.liteManagedAttached === "true") return Boolean(panel);
  panel.dataset.liteManagedAttached = "true";
  if (document.documentElement.dataset.liteMenuDismissAttached !== "true") {
    document.documentElement.dataset.liteMenuDismissAttached = "true";
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".h3-lite-add-control")) closeMenus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenus();
    });
  }
  const refreshButton = document.querySelector("[data-model-refresh]");
  refreshButton?.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    setTimeout(() => refresh({ force: true, rescan: true }), 0);
  });
  const modelSelect = panel.querySelector("[data-installed-model]");
  if (modelSelect) {
    new MutationObserver(() => {
      if (currentState) decorateModelOptions(currentState);
    }).observe(modelSelect, { childList: true });
  }
  panel.addEventListener("change", (event) => {
    if (!event.target.closest("[data-installed-model]")) return;
    setTimeout(() => {
      saveConfig({ selected_model: currentModelPath() }, { refreshModels: true }).catch(showError);
    }, 0);
  }, true);
  refresh();
  return true;
}

export function startManagedGGUF() {
  for (const name of ["managed_gguf", "managed_gguf-theme-light", "managed_gguf-text-large"]) {
    if (document.querySelector(`link[data-h3-lite-stylesheet="${name}"]`)) continue;
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = `/scripts/${name}.css`;
    stylesheet.dataset.h3LiteStylesheet = name;
    document.head.append(stylesheet);
  }
  if (!attach()) {
    const observer = new MutationObserver(() => {
      if (attach()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
