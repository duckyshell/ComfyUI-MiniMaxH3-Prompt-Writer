# Direct GGUF

Direct GGUF loads a local multimodal model inside ComfyUI. Choose it when you want Writer to manage model loading, Context, KV cache, and unload without a separate model server.

This is an optional advanced path. Most users should start with [Ollama](OLLAMA.md).

![Direct GGUF settings](assets/v0.3/direct-gguf-settings.png)

## What you need

- A compatible native `llama-cpp-python` runtime installed in the Python environment that starts ComfyUI.
- One supported model GGUF.
- For image and video-reference modes, the matching multimodal projector (`mmproj`) from the same model class.

A model without an active projector remains usable as text-only Direct GGUF. Writer keeps T2VA and Refine available, disables I2VA, FL2VA, L2VA, Reference, and Music 3, and shows why vision is unavailable.

Workflow safetensors, checkpoints, and text encoders are unrelated to the Direct prompt model.

## Windows Portable with NVIDIA

Open PowerShell or Command Prompt in the ComfyUI Portable folder that contains `python_embeded`, then run:

```powershell
.\python_embeded\python.exe -m pip install --only-binary=:all: --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 "llama-cpp-python>=0.3.35,<0.4"
```

Restart ComfyUI and open **H3 Prompt Writer > Settings > Direct GGUF**. Settings shows a supported installed package as **Runtime detected**.

This preflight checks that `llama-cpp-python` is installed, its version is supported, and the Python module is available without importing the native runtime. Native compatibility and GPU execution are exercised only when a Direct model is actually loaded and used.

The Direct runtime was validated on the official NVIDIA Windows Portable build used for local validation:

- Python 3.13.14
- PyTorch `2.13.0+cu130`
- CUDA 13.0
- `llama-cpp-python 0.3.34` for the existing Gemma configurations
- `llama-cpp-python 0.3.35` for Qwen 3.8
- `GGML_TYPE_F16` import and CUDA GPU offload
- real multimodal generation and unload

The prebuilt native wheel is not validated for every CPU, CUDA version, Python version, or ComfyUI distribution. Keep `--only-binary=:all:` in the command so an unavailable wheel fails instead of starting an unplanned local C++ build.

## Add a model and optional projector

Open **Browse verified models** in Direct settings. Download the model file and, for visual modes, its projector from the same listed model row. Place them together under:

```text
ComfyUI/models/LLM/
```

Subfolders are supported. For multiple models, keep each model and its matching projector in its own folder:

```text
ComfyUI/models/LLM/
├── gemma-4-12b/
│   ├── gemma-4-12b-it-Q4_K_S.gguf
│   └── mmproj-BF16.gguf
├── gemma-4-26b/
│   ├── gemma-4-26B-A4B-it-UD-Q4_K_M.gguf
│   └── mmproj-BF16.gguf
├── qwen-3.8-27b/
    ├── Qwen3.8-27B-UD-Q4_K_XL.gguf
    └── mmproj-BF16.gguf
└── qwen3-vl-8b/
    ├── Qwen3VL-8B-Instruct-Q4_K_M.gguf
    └── mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf
```

Do not share an `mmproj` across model classes because the filenames happen to match. Writer enables vision only when it can pair one model GGUF with one projector unambiguously. A missing or ambiguous projector does not hide the model; it leaves the model available in text-only T2VA mode and reports the pairing problem in Direct settings and Scan details.

Select **Refresh** after adding files. Expand **Scan details** if the model does not appear.

## Verified Direct pairs

| Starting GPU tier | Model GGUF | Matching projector |
| --- | --- | --- |
| 8 GB | [Gemma 4 E4B Q3_K_M](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/blob/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q3_K_M.gguf) | [E4B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/blob/bfc15c382204943c3a8fff0c750b94ae2364d7a3/mmproj-BF16.gguf) |
| 12 GB | [Gemma 4 12B Q4_K_S](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q4_K_S.gguf) | [12B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/mmproj-BF16.gguf) |
| 16 GB | [Gemma 4 12B Q5_K_M](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q5_K_M.gguf) | [12B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/mmproj-BF16.gguf) |
| 24 GB | [Gemma 4 26B-A4B Q4_K_M](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/blob/c099eb48e663fd284577b04978a94ffccb261841/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf) | [26B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/blob/c099eb48e663fd284577b04978a94ffccb261841/mmproj-BF16.gguf) |
| 32 GB | [Gemma 4 31B Q4_K_XL](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/blob/c1ac76e99d5513b141e8adde7288b85c3f9c32ec/gemma-4-31B-it-UD-Q4_K_XL.gguf) | [31B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/blob/c1ac76e99d5513b141e8adde7288b85c3f9c32ec/mmproj-BF16.gguf) |

These are measured starting tiers, not hard requirements or quality rankings. They are the currently published verified Gemma 4 pairs. Direct also recognizes compatible Qwen GGUF models from their metadata. A custom model and projector pair is labeled compatible/unverified until that exact combination has been tested. An unknown architecture remains visible in Scan details but is not loaded.

The verified Qwen configuration is [Qwen 3.8 27B UD-Q4_K_XL](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q4_K_XL.gguf) with its matching [BF16 projector](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/4ca720788d1e01f1bff70c033e0d0028fd02e502/mmproj-BF16.gguf). It is intentionally not assigned a Gemma-style GPU starting tier: it is a large model, and actual headroom depends strongly on the chosen 16K–48K context, KV format, display use, and other loaded GPU workloads. Measure it on the target machine.

The official [Qwen3-VL 8B Instruct Q4_K_M](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/blob/f982a07559d4a2f6c8744d840bf6fccab30eea96/Qwen3VL-8B-Instruct-Q4_K_M.gguf) with its matching [Q8_0 projector](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/blob/f982a07559d4a2f6c8744d840bf6fccab30eea96/mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf) is also verified for text, image, and repeated generation in one process. No universal GPU starting tier is assigned from that short smoke. `qwen3vlmoe` is recognized by the runtime and generic MTMD adapter but remains custom/unverified because no live model/projector pair was tested.

## Qwen model policy

Architecture, model lineage, and verified configuration are separate. The GGUF architecture selects the loading path. It does not by itself enable defaults for a specific Qwen release.

The `qwen3vl` and `qwen3vlmoe` adapters also select only generic loading, MTMD, and `qwen3vl_merger` compatibility. They do not inherit Qwen 3.8/3.6 sampling, `reasoning_effort`, or Thinking policy. The verified Qwen3-VL 8B template exposes no Direct Thinking control.

Direct recognizes Qwen 3.8 27B from base-model provenance in the GGUF metadata. If provenance is absent, it accepts only a complete match for the model's key architecture values. This lets compatible fine-tunes use the Qwen 3.8 settings without treating every `qwen35` model as Qwen 3.8. Fine-tunes and other untested files remain compatible/unverified.

Thinking uses `temperature 1.0`, `top_p 0.95`, `top_k 20`, `min_p 0`, `presence_penalty 0`, and `repeat_penalty 1.0`; non-thinking uses `0.7`, `0.8`, `20`, `0`, `1.5`, and `1.0`. Thinking passes `reasoning_effort=low` only when the model lineage is Qwen 3.8 and the embedded template supports that option. The verified `Qwen3.8-27B-UD-Q4_K_XL.gguf` and `mmproj-BF16.gguf` pair is kept separate from compatible but unverified combinations.

The exact official `Qwen3.6-35B-A3B` metadata lineage has its own sampling settings and does not receive `reasoning_effort`. Unknown `qwen35` and `qwen35moe` lineages remain custom/unverified and use the generic Direct settings.

Qwen Thinking output is split from the final prompt whether the runtime returns `reasoning_content` separately or emits a completed `</think>` prefix. Private reasoning is never included in the returned H3 prompt. A missing closing tag is treated as truncated Thinking. MTP/`nextn` tensors are detected for diagnostics but intentionally remain disabled.

The validated Qwen adapter floor is `llama-cpp-python 0.3.35`; Gemma remains compatible with the existing 0.3.34 floor. If 0.3.34 is installed, Qwen is discoverable but not runtime-ready and Settings reports the required update before any weights are loaded.

The verified Qwen 3.8 configuration completed T2VA, I2VA, FL2VA, L2VA, and Reference with Thinking both off and on. A 48K maximum-Reference run with nine images and three ordered video contact sheets completed without fallback or OOM, and unload/reload also completed. Peak observed GPU memory was 22,959 MiB on the validation machine; this is evidence for that machine and workload, not a universal VRAM tier.

A local `qwen35moe` Qwen 3.6 fine-tune also completed T2VA, one image, Reference, and a 24K Thinking run. That run used 4,400 reasoning tokens without truncation. Its metadata lineage is custom, so it correctly remains compatible/unverified and does not inherit the official Qwen 3.6 policy.

Direct continues to send videos as the ordered contact sheet shown in Writer. The current `llama-cpp-python` high-level MTMD handler has no stable public native-video input; an undocumented MP4 path was not reliable and is intentionally not used. A control smoke through official `llama-server b10603` and its documented `input_video` endpoint also stalled after media loading on the tested build, so native video remains deferred rather than introducing a second runtime path.

## Context and KV cache

Direct is the only provider with manual Context and KV controls in Writer.

- **Context Auto** chooses the smallest tier that fits the assembled input, complete output budget, and a safety reserve. Gemma keeps its existing 8K/16K/24K choices; Qwen uses 16K/24K/32K/48K, capped by the GGUF's declared native context.
- **KV cache Auto** uses the tested Q8 policy. F16 is available manually.
- A manual context is respected. Writer reports when the request needs a larger tier instead of silently changing it.
- Thinking with Auto reserves the full reasoning and final-output budget before choosing context.
- Qwen text is counted before full load by a cached `vocab_only` tokenizer subprocess. It sets `n_gpu_layers=0` and hides CUDA, so preflight does not allocate model weights or GPU state.
- Qwen visual input is budgeted from the exact prepared image or contact-sheet dimensions and projector patch/grid metadata. Missing dimensions use a conservative fallback instead of silently assuming a small fixed image cost. Response `usage.prompt_tokens` is not used as the visual-token count because Qwen-VL M-RoPE prompt positions can be much smaller than the projector embedding grid.

The 48K ceiling is deliberate for the current Prompt Writer workload, including the maximum Reference media set. Direct does not automatically request Qwen 3.6's advertised 128K context or its very large possible output budget. A local custom Qwen 3.6 Thinking smoke completed at 24K, but custom lineage is still not promoted to a verified official policy.

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
.\python_embeded\python.exe -m pip install --no-cache-dir --only-binary=:all: --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 "llama-cpp-python>=0.3.35,<0.4"
```

Restart ComfyUI and confirm that Direct reports **Runtime detected**, then complete one real Direct generation. Do not copy native DLLs manually, replace ComfyUI's Python files, or install the package into an unrelated system Python.

If ComfyUI exits during the first Direct load or Windows reports `0xC000001D`, see [Illegal instruction](TROUBLESHOOTING.md#windows-0xc000001d-illegal-instruction). Reinstalling the same wheel repeatedly will not solve a CPU instruction incompatibility.
