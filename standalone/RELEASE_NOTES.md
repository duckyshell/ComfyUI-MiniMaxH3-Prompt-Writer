# H3 Prompt Writer Standalone v0.1.2

Standalone Windows version. ComfyUI is not required.

## Download

[Download H3-Prompt-Writer-Standalone-Windows-v0.1.2.zip](https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/releases/download/standalone-v0.1.2/H3-Prompt-Writer-Standalone-Windows-v0.1.2.zip)

Do not download **Source code (zip)** or **Source code (tar.gz)** for normal use.
Do not install this package into ComfyUI `custom_nodes`.

## Fixed

- Fixed Local GGUF generation failing before the model could respond.
- Restored Thinking controls for Local GGUF models whose templates support them.

## Features

- Ollama
- API providers
- External llama.cpp
- Existing local GGUF models through a user-selected `llama-server.exe`
- Vision GGUF projectors with metadata-based matching
- Combined and removable model locations
- Local GGUF Context, KV cache, Generation budget, and supported reasoning effort controls
- Video Creative Briefs up to 8,000 characters

External llama.cpp keeps its own reasoning and chat-template settings. Writer separates returned reasoning from the final H3 prompt without overriding the server.

No ComfyUI installation is required. Models, API keys, llama.cpp binaries, and CUDA
libraries are not bundled.

## Requirements

- Windows 10 or 11, x64
- Python 3.10 or newer, or `uv`
- At least one configured provider

Based on H3 Prompt Writer extension `0.4.3`.
