# Changelog

## 0.2.1 - 2026-08-11

- Added a browser-compatible UUID fallback for ComfyUI opened through non-secure
  LAN HTTP origins.
- Fixed repeated media drop listeners that could upload the same file more than
  once after UI rerenders.
- Made dropping one media card onto another reorder it in either direction
  without requiring the pointer to cross the target card's outer edge.
- Changed Auto video sampling to 6 frames, added explicit 4/6/8 options, and
  cache-busted regenerated previews, contact sheets, and frames so every
  selection displays the new sheet.
- Added exact model scan paths, discovered GGUF/mmproj files, and pairing issues
  to local model setup details without changing discovery rules.
- Added a lazy, cached, subprocess-isolated `llama-cpp-python` compatibility
  check before Direct GGUF generation and refinement.
- Added actionable details for native probe crashes, invalid CUDA/HIP runtime
  paths, and unavailable GPU offload without assuming a specific backend.

## 0.2.0 - 2026-08-10

- Added optional support for an existing local OpenAI-compatible `llama.cpp`
  server with a loaded Gemma 4 model and matching vision projector.
- Added connection, health, vision-capability, cancellation, and external model
  lifecycle handling while leaving model and runtime configuration to the server.

## 0.1.0 - 2026-08-09

- First public release of the ComfyUI UI extension.
- T2VA, I2VA, FL2VA, L2VA, and Reference prompt generation.
- Local multimodal Gemma 4 GGUF support with matching projector validation.
- Ordered video contact sheets, editable prompts, Refine, Cancel, and contextual
  ComfyUI/prompt-model VRAM release.
- Automatic context preflight and compact advanced runtime controls.
- Measured free-VRAM preflight with native ComfyUI unload-and-retry handling.
- Released as version 0.1.0 under the MIT License.
