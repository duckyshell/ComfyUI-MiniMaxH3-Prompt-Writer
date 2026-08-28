# H3 Prompt Writer Standalone for Windows

Use H3 Prompt Writer without ComfyUI.

Current Standalone version: **0.1.1**

[Download H3 Prompt Writer Standalone v0.1.1](https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer/releases/download/standalone-v0.1.1/H3-Prompt-Writer-Standalone-Windows-v0.1.1.zip)

## This is the Standalone version

You do not need ComfyUI. Do not install this ZIP into ComfyUI `custom_nodes`.

Looking for the ComfyUI extension? See
[H3 Prompt Writer for ComfyUI](../README.md).

- ✓ Ollama
- ✓ API providers
- ✓ External llama.cpp
- ✓ Existing local GGUF models
- ✓ Vision GGUF projectors

No ComfyUI installation is required. Models, API keys, and `llama.cpp` binaries are
not bundled.

## Start

1. Extract the ZIP to a writable folder.
2. Double-click `start.bat`.
3. Open **Settings**, choose a provider, and select a model.

On first launch, Standalone creates a private `.venv` beside the application and
installs three small Python packages. Nothing is installed globally. Windows needs
Python 3.10 or newer, or `uv`, unless a future release includes portable Python.

The ZIP contains `data/settings.example.json`, not a live `settings.json`. Existing
runtime and model locations are therefore not replaced when a newer ZIP is extracted
over the same folder.

The Writer opens directly in a full-window browser view. Close the browser tab or
window normally.

## Providers

### Ollama

Choose an installed Ollama model. Existing local and remote-host behavior is provided
by H3 Prompt Writer.

### API providers

Connect a supported provider in Settings. API keys stay in backend memory for the
current Writer session and are not saved by Standalone.

### External llama.cpp

Connect to a `llama-server` that you already started. The external server owns model
loading, context, KV cache, and shutdown.

### Local GGUF

Standalone can start and stop a user-supplied `llama-server.exe` for existing GGUF
models:

1. Download the appropriate Windows archive from the official
   [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases).
2. Open **Settings → Local GGUF** and choose `llama-server.exe`.
3. Use **Add models…** to choose one model GGUF or scan a folder.
4. Select a model from the combined model list.
5. Review the matched vision projector, or choose one manually.

Use **Locations · N** to see remembered model folders, forget one, or forget all.
Forgetting a location never deletes files. Use the runtime card's **Manage** menu to
change or forget `llama-server.exe`.

Model and projector roles are read from GGUF metadata, not filenames. Unknown files
remain selectable as **Unverified**. If several projectors match, Standalone asks you
to choose; the actual `llama-server` load is the final compatibility check.

Standalone does not guess or download CUDA, CPU, or Vulkan builds. It starts at most
one managed server on `127.0.0.1`, reuses it while the configuration is unchanged,
and keeps native runtime failures outside the Writer process. `llama-cpp-python` is
not used for Local GGUF.

## Notes

- The local Writer host binds only to `127.0.0.1`.
- Browser requests use the local host; provider calls are made by the Python backend.
- Local runtime paths and model locations are stored only in the extracted copy's
  `data/` folder.
- Qwen3.8 receives `reasoning_effort=low` and a 24K automatic context only when its
  embedded chat template explicitly supports that control.
- Local GGUF provides managed Context, KV cache, Generation budget, and supported
  reasoning effort controls. External llama.cpp remains server-managed.

## Development

The standalone layer is intentionally small. In this repository it imports the shared
`backend/`, `web/`, guides, and model metadata directly. A portable build vendors a
clean snapshot of those shared files. Standalone-specific behavior stays in adapter
files so normal core commits are immediately available to both hosts.

Optional development settings live in `data/settings.json`:

```json
{
  "upstream_repo": "C:\\path\\to\\prompt-writer",
  "model_roots": ["D:\\Models"],
  "port": 8765,
  "open_browser": true
}
```

Command-line overrides are also available:

```text
start.bat --upstream C:\path\to\prompt-writer --model-root D:\Models --port 9000 --no-browser
```

From the repository root, build the portable package with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_standalone.ps1
```

The result is `dist\H3-Prompt-Writer-Standalone-Windows-v0.1.1.zip`. It records the
repository commit in `upstream\UPSTREAM_SNAPSHOT.txt` and excludes local settings,
logs, models, `llama-server`, CUDA libraries, and test artifacts.
