# Direct GGUF

Direct GGUF loads a local multimodal model inside ComfyUI. Choose it when you want Writer to manage model loading, Context, KV cache, and unload without a separate model server.

This is an optional advanced path. Most users should start with [Ollama](OLLAMA.md).

![Direct GGUF settings](assets/v0.3/direct-gguf-settings.png)

## What you need

- A compatible native `llama-cpp-python` runtime installed in the Python environment that starts ComfyUI.
- One supported model GGUF.
- The matching multimodal projector (`mmproj`) from the same model class.

Workflow safetensors, checkpoints, and text encoders are unrelated to the Direct prompt model.

## Windows Portable with NVIDIA

Open PowerShell or Command Prompt in the ComfyUI Portable folder that contains `python_embeded`, then run:

```powershell
.\python_embeded\python.exe -m pip install --only-binary=:all: --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 "llama-cpp-python>=0.3.34,<0.4"
```

Restart ComfyUI and open **H3 Prompt Writer > Settings > Direct GGUF**. Settings shows a supported installed package as **Runtime detected**.

This preflight checks that `llama-cpp-python` is installed, its version is supported, and the Python module is available without importing the native runtime. Native compatibility and GPU execution are exercised only when a Direct model is actually loaded and used.

This command was validated on the official NVIDIA Windows Portable build used for v0.3 validation:

- Python 3.13.14
- PyTorch `2.13.0+cu130`
- CUDA 13.0
- `llama-cpp-python 0.3.34`
- `GGML_TYPE_F16` import and CUDA GPU offload
- real multimodal generation and unload

The prebuilt native wheel is not validated for every CPU, CUDA version, Python version, or ComfyUI distribution. Keep `--only-binary=:all:` in the command so an unavailable wheel fails instead of starting an unplanned local C++ build.

## Add a model and projector

Open **Browse verified models** in Direct settings. Download both files from the same listed model row and place them together under:

```text
ComfyUI/models/LLM/
```

Subfolders are supported. For multiple models, keep each model and its matching projector in its own folder:

```text
ComfyUI/models/LLM/
├── gemma-4-12b/
│   ├── gemma-4-12b-it-Q4_K_S.gguf
│   └── mmproj-BF16.gguf
└── gemma-4-26b/
    ├── gemma-4-26B-A4B-it-UD-Q4_K_M.gguf
    └── mmproj-BF16.gguf
```

Do not share an `mmproj` across model classes because the filenames happen to match. Writer accepts a directory only when it can pair one model GGUF with one projector unambiguously.

Select **Refresh** after adding files. Expand **Scan details** if the model does not appear.

## Verified Direct pairs

| Starting GPU tier | Model GGUF | Matching projector |
| --- | --- | --- |
| 8 GB | [Gemma 4 E4B Q3_K_M](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/blob/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q3_K_M.gguf) | [E4B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/blob/bfc15c382204943c3a8fff0c750b94ae2364d7a3/mmproj-BF16.gguf) |
| 12 GB | [Gemma 4 12B Q4_K_S](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q4_K_S.gguf) | [12B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/mmproj-BF16.gguf) |
| 16 GB | [Gemma 4 12B Q5_K_M](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q5_K_M.gguf) | [12B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/mmproj-BF16.gguf) |
| 24 GB | [Gemma 4 26B-A4B Q4_K_M](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/blob/c099eb48e663fd284577b04978a94ffccb261841/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf) | [26B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/blob/c099eb48e663fd284577b04978a94ffccb261841/mmproj-BF16.gguf) |
| 32 GB | [Gemma 4 31B Q4_K_XL](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/blob/c1ac76e99d5513b141e8adde7288b85c3f9c32ec/gemma-4-31B-it-UD-Q4_K_XL.gguf) | [31B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/blob/c1ac76e99d5513b141e8adde7288b85c3f9c32ec/mmproj-BF16.gguf) |

These are measured starting tiers, not hard requirements or quality rankings. Direct GGUF currently supports only these verified Gemma 4 pairs. Its model loading and vision-projector integration are built specifically for Gemma 4. Use Ollama, External llama.cpp, or a compatible API endpoint to try Qwen or another multimodal model.

## Context and KV cache

Direct is the only provider with manual Context and KV controls in Writer.

- **Context Auto** chooses the smallest sufficient 8K, 16K, or 24K tier from the assembled input and output budget.
- **KV cache Auto** uses the tested Q8 policy. F16 is available manually.
- A manual context is respected. Writer reports when the request needs a larger tier instead of silently changing it.
- Thinking with Auto reserves the full reasoning and final-output budget before choosing context.

Increasing context or using F16 KV consumes more VRAM. If preflight reports insufficient free VRAM, use a smaller model or release other GPU models.

## Model lifecycle

With **Keep model loaded** off, Direct unloads after every request. With it on:

- **Unload Direct** releases the idle Direct model.
- **Stop & unload** cancels the current Direct request and unloads at the next safe backend point.
- **Cancel** stops the request without forcing a previously retained model to unload.

**Free ComfyUI VRAM** is separate. It releases workflow models loaded by ComfyUI, not the Direct prompt model.

## After a ComfyUI update

The normal official `update_comfyui.bat` path was tested. It kept the embedded Python environment, Direct runtime, GPU offload, multimodal generation, and unload working.

If an update replaces `python_embeded` or leaves mixed native packages, reinstall the optional runtime once:

```powershell
.\python_embeded\python.exe -m pip uninstall llama-cpp-python -y
.\python_embeded\python.exe -m pip install --no-cache-dir --only-binary=:all: --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 "llama-cpp-python>=0.3.34,<0.4"
```

Restart ComfyUI and confirm that Direct reports **Runtime detected**, then complete one real Direct generation. Do not copy native DLLs manually, replace ComfyUI's Python files, or install the package into an unrelated system Python.

If ComfyUI exits during the first Direct load or Windows reports `0xC000001D`, see [Illegal instruction](TROUBLESHOOTING.md#windows-0xc000001d-illegal-instruction). Reinstalling the same wheel repeatedly will not solve a CPU instruction incompatibility.
