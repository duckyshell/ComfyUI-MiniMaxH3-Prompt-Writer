# Changelog

## 0.2.1 - 2026-08-11

- Added a browser-compatible UUID fallback for ComfyUI opened through non-secure
  LAN HTTP origins.
- Fixed repeated media drop listeners that could upload the same file more than
  once after UI rerenders.
- Added exact model scan paths, discovered GGUF/mmproj files, and pairing issues
  to local model setup details without changing discovery rules.
- Added a lazy, cached, subprocess-isolated `llama-cpp-python` compatibility
  check before Direct GGUF generation and refinement.
- Added actionable details for native probe crashes, invalid CUDA/HIP runtime
  paths, and unavailable GPU offload without assuming a specific backend.

## 0.1.0 - 2026-08-09

- First public release of the ComfyUI UI extension.
- T2VA, I2VA, FL2VA, L2VA, and Reference prompt generation.
- Local multimodal Gemma 4 GGUF support with matching projector validation.
- Ordered video contact sheets, editable prompts, Refine, Cancel, and contextual
  ComfyUI/prompt-model VRAM release.
- Automatic context preflight and compact advanced runtime controls.
- Measured free-VRAM preflight with native ComfyUI unload-and-retry handling.
- Released as version 0.1.0 under the MIT License.
