function replaceStandaloneText(element) {
  if (!element || element.childElementCount) return;
  const text = element.textContent || "";
  const next = text
    .replaceAll("Free ComfyUI VRAM", "Release model memory")
    .replaceAll("Models installed in ComfyUI", "Models available to Standalone")
    .replaceAll("ComfyUI Python environment", "Standalone Python environment")
    .replaceAll("ComfyUI/models/LLM/", "models/ (or a configured --model-root)")
    .replaceAll("Close ComfyUI", "Stop H3 Prompt Writer")
    .replaceAll("your ComfyUI Portable folder containing python_embeded", "this package's local Python environment")
    .replaceAll("restart ComfyUI", "restart H3 Prompt Writer")
    .replaceAll("llama-cpp-python", "llama.cpp");
  if (next !== text) element.textContent = next;
}

function applyHostLabels() {
  const directOption = document.querySelector('[data-provider-option="direct"] small');
  if (directOption && directOption.textContent !== "Existing files via llama-server") {
    directOption.textContent = "Existing files via llama-server";
  }

  const memoryButton = document.querySelector("[data-comfy-memory-action]");
  if (memoryButton) {
    for (const node of memoryButton.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = node.textContent.replace("Free ComfyUI VRAM", "Release model memory");
      }
    }
    memoryButton.disabled = true;
    memoryButton.setAttribute("aria-disabled", "true");
    memoryButton.title = "Standalone manages the selected model itself";
  }

  const directPanel = document.querySelector('[data-provider-panel="direct"]');
  directPanel?.querySelectorAll("small, p, em, strong, code").forEach(replaceStandaloneText);
}

export function startHostLabels() {
  applyHostLabels();
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      applyHostLabels();
    }, 0);
  }).observe(document.body, { childList: true, subtree: true });
}
