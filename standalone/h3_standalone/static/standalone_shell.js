function enterStandaloneFullscreen() {
  const root = document.querySelector(".h3ps-root");
  if (!root) return;
  const toggle = root.querySelector("[data-fullscreen-toggle]");
  if (toggle?.getAttribute("aria-pressed") !== "true") toggle.click();
  root.dataset.standaloneShell = "true";
  document.documentElement.dataset.h3StandaloneShell = "ready";
}

function keepComfyActionInactive() {
  const button = document.querySelector("[data-comfy-memory-action]");
  if (!button) return;
  if (!button.disabled) button.disabled = true;
  if (button.getAttribute("aria-disabled") !== "true") button.setAttribute("aria-disabled", "true");
  if (button.title !== "Standalone manages the selected model itself") {
    button.title = "Standalone manages the selected model itself";
  }
}

function keepStandaloneOpen(event) {
  if (event.key !== "Escape") return;
  const root = document.querySelector('.h3ps-root[data-standalone-shell="true"].is-open');
  if (!root) return;

  const imagePreview = root.querySelector("[data-h3ps-image-preview].is-open [data-close-image-preview]");
  const videoPreview = root.querySelector("[data-h3ps-preview].is-open [data-close-preview]");
  const otherModels = root.querySelector("[data-other-models-popover]:not([hidden]) [data-other-models-close]");
  const closeOverlay = imagePreview || videoPreview || otherModels;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeOverlay?.click();
}

export function startStandaloneShell() {
  enterStandaloneFullscreen();
  keepComfyActionInactive();
  document.addEventListener("keydown", keepStandaloneOpen, true);
  new MutationObserver(() => {
    enterStandaloneFullscreen();
    keepComfyActionInactive();
  }).observe(document.body, { childList: true, subtree: true });
}
