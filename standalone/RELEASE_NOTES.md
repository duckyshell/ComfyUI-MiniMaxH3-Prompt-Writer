# H3 Prompt Writer Standalone v0.1.10

Standalone Windows version. ComfyUI is not required.

## Download

Download **H3-Prompt-Writer-Standalone-Windows-v0.1.10.zip** from the release assets below.

Do not download **Source code (zip)** or **Source code (tar.gz)** for normal use.
Do not install this package into ComfyUI `custom_nodes`.

## What's new

- Optional sampling controls for API providers, with saved overrides and a reset to provider defaults ([#44](https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/issues/44)).
- Compatibility fixes for Anthropic's OpenAI-compatible API endpoint ([#41](https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/issues/41)).
- Updated the shared Writer core to `0.4.8`.

Start Standalone with `start.bat` first; the installed app needs the local server running at the same address.

ComfyUI-only controls, including Auto VRAM management and Add to workflow, are not
shown in Standalone.

## Features

- Ollama
- API providers
- External llama.cpp
- Existing local GGUF models through a user-selected `llama-server.exe`
- Vision GGUF projectors with metadata-based matching
- Combined and removable model locations
- Local GGUF Context, KV cache, Generation budget, and supported reasoning effort controls
- Single and Sequence Creative Briefs without a character limit; model context limits still apply

External llama.cpp keeps its own reasoning and chat-template settings. Writer separates returned reasoning from the final H3 prompt without overriding the server.

No ComfyUI installation is required. Models, API keys, llama.cpp binaries, and CUDA
libraries are not bundled.

## Requirements

- Windows 10 or 11, x64
- Python 3.10 or newer, or `uv`
- At least one configured provider

Based on H3 Prompt Writer extension `0.4.8`.
