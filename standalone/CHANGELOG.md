# Standalone changelog

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
