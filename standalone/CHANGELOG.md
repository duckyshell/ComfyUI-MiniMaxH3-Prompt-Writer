# Standalone changelog

## 0.1.10 - 2026-10-28

- Added optional sampling controls for API providers, with saved overrides and a reset to provider defaults ([#44](https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/issues/44)).
- Fixed compatibility with Anthropic's OpenAI-compatible API endpoint ([#41](https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/issues/41)).
- Updated the shared Writer core to `0.4.8`.

## 0.1.9 - 2026-09-23

- Open Writer as an installed browser app with its own window and taskbar icon. Thanks to @kaalibro (#35).

## 0.1.8 - 2026-09-22

- Save and load text drafts for Single and Sequence from Actions.
- Extract and download audio from a selected video interval.
- Set a manual generation budget for Ollama.
- Keep Single Reference labels in sync after deleting or reordering media.
- Write longer Creative Briefs without a character limit or scroll jumps.
- Enable desktop notifications when generation finishes.

## 0.1.7 - 2026-09-11

- Fixed video trimming and cropping failing because NumPy was missing.
- Existing Windows environments now install missing dependencies on launch.

## 0.1.6 - 2026-09-10

- Fixed a Local GGUF crash when processing large images with vision models.
- Added server log details when a Local GGUF connection is interrupted.

## 0.1.5 - 2026-09-09

- Added **Sequence mode**: write a series of timed clips from one brief, keep action and references consistent, and edit each prompt separately.
- Added **Compact mode** for Sequence.
- Improved draft saving, model switching, generation reliability and video playback. Added text-only Music 3 and a Linux launcher for source installs.
- Updated the shared Writer core to `0.4.6`.

## 0.1.4 - 2026-09-06

- Updated to the shared H3 Prompt Writer `0.4.5` interface and core.
- Added Media Composer for collages and Media Editor for crop and trim.
- Added Light theme and adjustable Interface Size.
- Added model selection and unload controls for compatible external llama.cpp routers.
- Kept ComfyUI-only workflow and memory controls out of Standalone.

## 0.1.3 - 2026-09-02

- Updated the shared Writer interface and core to H3 Prompt Writer extension `0.4.4`.
- Added a compact Clear menu for clearing prompts while keeping media, or clearing the entire workspace.
- Added custom 2–16 frame contact sheets with more readable frame labels.
- Improved safe remote Ollama host editing and private-network hostname handling.

## 0.1.2 - 2026-08-30

- Fixed Local GGUF generation failing before the model could respond.
- Restored Thinking controls for Local GGUF models whose templates support them.

## 0.1.1 - 2026-08-29

- Updated the shared Writer interface and core to H3 Prompt Writer extension `0.4.3`.
- Added Local GGUF Custom Context, KV cache, Generation budget, and supported reasoning effort controls.
- Improved metadata-based model and projector detection for renamed GGUF files.
- Increased the video Creative Brief limit to 8,000 characters.
- Kept External llama.cpp reasoning settings under server control.
- Fixed Local GGUF generation-budget handling.

## 0.1.0 - 2026-08-27

- First Windows Standalone release candidate.
- Reuses the shared H3 Prompt Writer core without requiring ComfyUI.
- Supports Ollama, API providers, External llama.cpp, and existing local GGUF models.
- Manages a user-selected `llama-server.exe` outside the Python process.
- Supports GGUF vision projectors, combined model locations, and metadata-based pairing.
- Based on H3 Prompt Writer extension `0.4.2`.
