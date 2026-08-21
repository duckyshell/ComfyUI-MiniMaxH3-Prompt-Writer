# Changelog

## 0.3.4 - 2026-08-21

### Fixes

- Increased the non-Thinking H3 output ceiling from 1,536 to 2,048 tokens to reduce prompt truncation on longer generations and refinements.
- Prevented Direct GGUF cleanup from failing when the vision handler had already closed its exit stack.

## 0.3.3 - 2026-08-21

### Interface

- Added fullscreen Writer mode with a persistent toggle and improved large-screen layout.
- Improved Refine controls with a vertically resizable instruction editor and clearer Refine and Cancel actions.

### Fixes

- Refine now uses the current edited prompt as the source for each revision and keeps media as manifest-only context instead of re-uploading it.
- Stabilized Reference audio handling so untouched audio references are preserved while explicitly targeted references can change.
- Fixed the Free ComfyUI VRAM action returning to its normal state after a request.
- Added compatibility with newer `llama-cpp-python` GGML type exports.
- Improved Custom OpenAI-compatible connection errors, including non-JSON HTTP failures and missing model-list handling.
- Fixed long Creative Brief sizing when reopening the Writer and when using fullscreen.
- Scoped prompt-model visual reads to media owned by the current Writer session.
- Made Direct GGUF and Ollama startup detection less invasive while preserving the tested Windows Portable CUDA 13 install guidance.

## 0.3.2 - 2026-08-14

### Features

- Added an optional Music 3 workspace for writing structured captions for the separate MiniMax Music 3 model.
- Added saved Music Brief, optional Lyrics, editable generated captions, and separate Caption and Lyrics system prompts.
- Added one Lyrics Refine flow for creating new Lyrics or rewriting the current text, with optional Music Brief context and one-step restore.
- Added a Reference mode control for inserting current reference tags at the caret in the Creative Brief, Generated Prompt, or Refine instruction.

### Fixes

- Allowed Custom OpenAI-compatible endpoints to use plain HTTP on loopback and private LAN addresses while keeping HTTPS required for public endpoints.
- Allowed External llama.cpp to use text-only models for requests without images or video. Visual requests now show a clear vision requirement.

## 0.3.1 - 2026-08-13

### Fixes

- Prevented media changes and mode switching during generation or refinement.
- Made media replacement and video resampling transactional so failed operations preserve the existing asset.
- Limited Clear to media in the current mode and ensured generation and refinement use the latest media after uploads, removals, resampling, and reordering.
- Fixed Reference Audio handling: uploaded audio remains optional, Generate honors exact `<Audio N>` tags in the Creative Brief, and Refine preserves untouched audio references while allowing explicitly tagged references to change.
- Rejected nonexistent canonical reference tags before loading or invoking the selected model.
- Improved Direct GGUF compatibility diagnostics.

## 0.3.0 - 2026-08-12

### New interface

- Redesigned the Writer and Settings interface.
- Added clear setup pages for Ollama, Direct GGUF, External llama.cpp, and API
  providers.
- Separated provider settings from shared prompt behavior.
- Added clearer model status, setup guidance, capability labels, and unload
  controls.

### New providers

- Added Ollama as the recommended local setup.
- Added automatic Ollama detection, installed-model discovery, tested Gemma 4
  recommendations, copyable pull commands, and request-aware context selection.
- Added optional API providers for Gemini, OpenAI, OpenRouter, and Custom
  OpenAI-compatible endpoints.
- Added Gemini Thinking levels and session-only API key handling.
- Added support for local OpenAI-compatible endpoints such as LM Studio.
- Gave the existing External llama.cpp integration its own dedicated provider
  setup.
- Validated Qwen 3.6 through Ollama in all five H3 modes without model-specific
  changes to Writer.

### Drafts and prompt behavior

- Added a separate saved Creative Brief and editable prompt draft for every mode,
  including Reference.
- Added saved provider preferences without storing API keys or active session
  state.
- Added shared Standard and Reference system-prompt profiles.
- Added a two-click option to restore all saved drafts to the current built-in
  defaults.
- Added mode-specific example drafts for T2VA, I2VA, FL2VA, L2VA, and Reference.

### Context and Thinking

- Added automatic context planning for the complete request, including prepared
  media, reasoning, and final output.
- Added request-aware Ollama context selection within the model's reported limit.
- Improved Thinking budgeting so larger Reference requests do not lose the
  requested reasoning budget to an undersized context.
- Kept provider-specific reasoning controls separate from the general local
  Thinking switch.

### Reference generation

- Added stricter checks for active `<Picture N>`, `<Video N>`, and `<Audio N>`
  references.
- Added one bounded multimodal correction when a visual reference is missing from
  the first prompt.
- Kept the original prompt and showed a persistent warning when a correction could
  not pass validation.
- Improved handling of motion-only references so unrelated identity, clothing,
  setting, lighting, and audio details are less likely to transfer.

### Model and VRAM controls

- Added separate controls for cancelling a request, unloading a Direct model,
  unloading an Ollama model, and freeing ComfyUI workflow VRAM.
- Added **Stop & unload** for active Direct and Ollama requests.
- Improved Ollama ownership tracking so Writer does not offer to unload models
  started by another application.
- Kept External llama.cpp and API model lifecycle under server or provider control.

### Fixes

- Fixed delayed first-stream responses from External llama.cpp being treated as a
  failed request.
- Fixed important generation warnings disappearing before they could be read.
- Fixed large Thinking requests falling back because the automatic context was too
  small.
- Fixed missing active visual references being repaired without access to the
  original media.
- Fixed provider discovery changing the open Settings provider page.
- Fixed unload controls disappearing after switching to another provider.
- Improved Direct GGUF guidance when the optional native runtime is missing or
  incompatible.

### Documentation

- Rewrote the installation, provider, usage, privacy, and troubleshooting guides
  for v0.3.
- Added practical Creative Brief and reference-role examples.
- Added new screenshots for the redesigned interface.

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
