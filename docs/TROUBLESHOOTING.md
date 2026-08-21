# Troubleshooting

Start by updating H3 Prompt Writer, restarting ComfyUI, and using `Ctrl+F5` if the browser still shows an older interface. The entries below describe problems that can still occur in v0.3.

## I installed it but cannot find a node

**Symptom**

ComfyUI Manager reports that the extension has no nodes, or nothing new appears in the graph.

**Cause**

H3 Prompt Writer is a UI extension, not a workflow node.

**Fix**

Open the floating **H3 Prompt Writer** button or use **Extensions > H3 Prompt Writer**. If neither is present, confirm that the repository is directly below `ComfyUI/custom_nodes`, restart ComfyUI, and check the startup console for an import error.

**Verify**

The Writer window opens. No graph node is expected.

## Direct runtime is not installed

**Symptom**

Direct GGUF says `llama-cpp-python is not installed` after the extension itself was installed.

**Cause**

Direct uses an optional native runtime. ComfyUI Manager installs the base extension but does not install this CUDA-specific package.

**Fix**

For the NVIDIA Windows Portable build used for v0.3 validation, open a terminal in the folder containing `python_embeded` and run:

```powershell
.\python_embeded\python.exe -m pip install --only-binary=:all: --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 "llama-cpp-python>=0.3.34,<0.4"
```

Restart ComfyUI.

**Verify**

Open **Settings > Direct GGUF**. Settings shows an accepted `llama-cpp-python` package as **Runtime detected**.

## Direct runtime is installed but broken

**Symptom**

The first Direct model load fails with `MODEL_LOAD_FAILED`, an import error, a missing native symbol, or another native runtime error.

**Cause**

The package can be installed in the wrong Python environment, come from an incompatible wheel, or retain mixed native files after an environment-changing update.

**Fix**

From the Windows Portable folder containing `python_embeded`, perform one clean replacement:

```powershell
.\python_embeded\python.exe -m pip uninstall llama-cpp-python -y
.\python_embeded\python.exe -m pip install --no-cache-dir --only-binary=:all: --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 "llama-cpp-python>=0.3.34,<0.4"
```

Do not install into system Python, copy native DLLs manually, or replace ComfyUI's embedded Python files.

**Verify**

Restart ComfyUI and complete a real Direct model load and generation.

## `GGML_TYPE_F16` cannot be imported

**Symptom**

Technical details include `cannot import name 'GGML_TYPE_F16' from 'llama_cpp'`.

**Cause**

The Python files and native package are inconsistent or are not the validated runtime. Workflow safetensors are unrelated.

**Fix**

Use the clean Direct-runtime replacement command from the previous entry in the Python environment that launches ComfyUI.

**Verify**

Restart ComfyUI and confirm that a real Direct model load succeeds.

## Direct is extremely slow or runs on CPU

**Symptom**

Direct generation is much slower than expected or runs mainly on CPU.

**Cause**

A CPU-only or incompatible `llama-cpp-python` wheel can import without providing the intended CUDA backend.

**Fix**

Install the wheel matching the Python and CUDA environment used by ComfyUI. The command above is validated only for the NVIDIA Windows Portable CUDA 13.0 build used for v0.3 validation. For another environment, use a compatible prebuilt wheel rather than assuming the cu130 command applies.

**Verify**

A real Direct generation completes without the CPU-only slowdown.

## Windows `0xC000001D` illegal instruction

**Symptom**

ComfyUI exits completely or Direct fails with `MODEL_LOAD_FAILED`, Windows `0xC000001D`, or `Illegal instruction` during the first native model load.

**Cause**

This is a native CPU-instruction failure. Wrong, mixed, or stale binaries can cause it. The current prebuilt `llama-cpp-python 0.3.34 cu130` wheel also contains AVX512 instructions, which creates a portability risk on CPUs without AVX512. The exact cause of every remote report is not proven without that machine's binary hash and crash details.

**Fix**

Try the clean replacement command once, because it can correct a wrong or mixed installation. Restart and retry. If the same `0xC000001D` remains, do not reinstall the same wheel repeatedly. Use the recommended [Ollama](OLLAMA.md) path or [External llama.cpp](EXTERNAL_LLAMA_SERVER.md) with a build suitable for the CPU.

The clean reinstall does not rebuild the wheel or disable AVX512.

**Verify**

A real Direct model load completes without terminating ComfyUI.

## Direct model or projector is not found

**Symptom**

Direct shows no ready models, a missing `mmproj`, or an ambiguous pairing.

**Cause**

Writer needs one model GGUF and one matching model-class projector in the same scanned folder. It does not guess among several candidates.

**Fix**

Put the verified pair together under `ComfyUI/models/LLM`. Use a separate subfolder for each pair, then select **Refresh**. Open **Scan details** to see every searched path and file.

Do not reuse a same-named `mmproj` from another model class.

**Verify**

The model appears under **Installed models**, has no missing dependency, and completes a real image request.

## Ollama is not running

**Symptom**

Ollama Settings show **Start Ollama** and the local service does not respond.

**Cause**

Writer does not start the Ollama application or service.

**Fix**

Open the Ollama app, wait for the local service to start, then select **Check now**.

**Verify**

Settings advance to Prompt model and show installed compatible models.

## An Ollama model is not available

**Symptom**

Ollama is ready, but the model picker is empty or does not contain the expected tag.

**Cause**

The exact tag has not been pulled, the pull is still running, or Ollama does not report the installed model as vision capable.

**Fix**

Run a command such as:

```text
ollama pull gemma4:e4b
```

After it finishes, select **Refresh** in Ollama Settings. Writer never downloads the model itself.

**Verify**

The exact tag appears in **Prompt model** and a real image request completes.

## External llama.cpp cannot connect

**Symptom**

External Settings cannot reach the server or report an invalid URL.

**Cause**

`llama-server` is stopped, uses another port, listens on another interface, or the URL contains an unsupported path.

**Fix**

Start `llama-server` and enter its loopback root, normally:

```text
http://127.0.0.1:8080
```

An input ending in `/v1` is accepted and normalized. Remove any other added path. Confirm that `/health` and `/v1/models` respond.

**Verify**

External Settings show the connected model. A text-only model is ready for Music 3, T2VA, and Refine. If you started the server with a projector, confirm vision with a real image request.

## Vision is unavailable

**Symptom**

A server or Custom endpoint connects, but Writer refuses image or video references.

**Cause**

The loaded model is text-only, its matching projector is missing, or the OpenAI-compatible model list does not advertise image support.

**Fix**

For External llama.cpp, restart with the model's matching `--mmproj`. You can keep using a text-only server for Music 3, T2VA, and Refine. For local LM Studio, load a vision model before reconnecting. For another Custom endpoint, enable **Endpoint accepts image_url inputs** only when both server and model support that contract.

**Verify**

The selected model shows **Vision** and completes a real image request.

## API authentication, rate limit, or truncated response

**Symptom**

The provider rejects the key, reports quota/billing/rate limit, or generation fails because the response reached its length limit.

**Cause**

Authentication, quotas, pricing, context, and output limits are provider and model specific. A successful connection does not guarantee free quota or sufficient output budget.

**Fix**

Confirm the key and selected model in the provider's console. Check current billing and rate-limit status. For Gemini, try **Minimal** or a lower Thinking level when latency or token use is the concern. Do not treat a response with `finish_reason=length` as a complete H3 prompt; Writer rejects it.

**Verify**

The request ends normally and the full editable prompt appears. Technical details should not report authentication, rate-limit, billing, or length termination.

## Context, Thinking, or memory failure

**Symptom**

Writer reports `CONTEXT_BUDGET_EXCEEDED`, `THINKING_CONTEXT_INSUFFICIENT`, insufficient free VRAM, or a runtime out-of-memory error.

**Cause**

Context capacity and memory are different limits. A request can exceed the selected token context while VRAM remains available, or fit the model context but fail because the runtime cannot allocate memory.

**Fix**

For Direct Auto, let Writer select 8K, 16K, or 24K. If a manual context is too small, choose the suggested tier. Reduce active references or use a model with a larger context limit when the request still does not fit.

For actual memory failure, use **Free ComfyUI VRAM**, close other GPU-heavy applications, select a smaller model, or reduce context. Do not increase context as a generic response to an OOM.

Ollama context is automatic in Writer; Ollama decides whether to offload parts of the model to CPU/RAM.

**Verify**

The next request completes without a context-limit or allocation error. If Thinking falls back, Writer reports it instead of presenting it as a full Thinking result.

## Reference prompt warning

**Symptom**

Writer says it repaired a missing reference tag or kept the original prompt with a format warning.

**Cause**

The first model draft omitted a required typed reference or failed an objective Reference format check. Pictures and videos are required. During Generate, uploaded audio is required only when the Creative Brief contains its exact `<Audio N>` tag. During Refine, existing audio tags remain required unless the revision instruction contains that exact tag, which makes the reference mutable for that revision.

**Fix**

When repair succeeds, review the corrected prompt. When it is rejected, the editor keeps the original prompt; remove irrelevant media, clarify each reference role in the Creative Brief, and generate again. A valid first draft is not rewritten.

**Verify**

Every active picture and video has its exact tag. Merely uploaded audio may remain unused. Refine preserves audio references not named by the revision instruction and accepts the prompt model's decision for each exact `<Audio N>` tag that the instruction does name. Every resulting reference tag exists in the current manifest.

## A reference transfers the wrong details

**Symptom**

A motion reference also changes the character, clothes, setting, lighting, or another detail that should come from a different file.

**Cause**

The Creative Brief did not limit the reference to a specific role, or the selected prompt model did not follow that limit closely enough.

**Fix**

State both the wanted role and the details that must not transfer. For example:

```text
Use only the movement and camera pacing from <Video 1>. Do not copy its performer, clothes, setting, lighting or audio. Keep the character appearance from <Picture 1> and the wardrobe from <Picture 2>.
```

Remove any active file that should not participate at all. Then generate again or use **Refine** with the same correction.

**Verify**

The final prompt names `<Video 1>` as the motion source while keeping appearance and wardrobe tied to the requested pictures.

## The interface looks old after updating

**Symptom**

Provider locations, labels, or controls do not match the current documentation.

**Cause**

The browser can retain an older extension script after files are updated.

**Fix**

Restart ComfyUI and hard-refresh the Writer page with `Ctrl+F5`.

**Verify**

Settings list Ollama, Direct GGUF, External llama.cpp, and API providers in that order.

## Collect technical details

Use the error's **Technical details** before changing the environment. It records the stage and available runtime information without assuming the user's diagnosis is correct.

Include the relevant ComfyUI console output when **Technical details** does not contain enough information.

Historical duplicate-upload, LAN `crypto.randomUUID`, and delayed-first-SSE External bugs were fixed in v0.2.1 or v0.3. Update first rather than applying old workarounds.
