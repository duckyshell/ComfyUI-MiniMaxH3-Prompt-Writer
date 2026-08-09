# Troubleshooting

## H3 Prompt Writer launcher is missing

- Open **Extensions > H3 Prompt Writer** from the ComfyUI menu.
- Confirm the repository folder is directly below `ComfyUI/custom_nodes/`.
- Check the ComfyUI startup console for an import error.
- Restart ComfyUI, then hard-refresh the browser with `Ctrl+F5`.

## No compatible local model found

Open the model menu. H3 Prompt Writer shows the exact model and projector links, the target
directory, and the tier that fits detected total VRAM.

Both files must be together below `ComfyUI/models/LLM/`. Press **Refresh** after
adding them.

## Model shows a missing dependency

- `llama-cpp-python`: install `requirements-gguf.txt` using ComfyUI's Python.
- `mmproj GGUF`: use the projector linked for the selected model in
  [MODELS.md](MODELS.md).

Identical projector filenames from different repositories are not interchangeable.

## Model loads on CPU or is extremely slow

A CPU-only `llama-cpp-python` wheel may import successfully. Reinstall a wheel built
for the CUDA version and Python version used by ComfyUI.

## External llama.cpp server is unavailable

- Use the server root URL, for example `http://127.0.0.1:8080`, not a `/v1` endpoint.
- Confirm that `llama-server` is running and that its `/health` endpoint responds.
- This release intentionally accepts servers on the same computer only.
- If H3 Prompt Writer reports that vision is unavailable, restart the server with
  the matching `mmproj` for the loaded Gemma 4 model.
- Context and KV cache are configured when starting the server. Leave both Writer
  settings on Auto.

Cancelling a prompt closes the active request but leaves the external process and
its loaded model unchanged.

## MODEL_LOAD_OOM

- Unload other ComfyUI models and close GPU-heavy applications.
- Select a smaller model tier.
- Keep Context on Auto unless the request genuinely needs a manual larger context.

## INSUFFICIENT_FREE_VRAM

H3 Prompt Writer stopped before loading the prompt model because other ComfyUI workflow
models occupy the measured memory budget. Use **Free ComfyUI VRAM & retry**. This
unloads workflow models but keeps cached node results, so it does not delete or
change the workflow.

## CONTEXT_BUDGET_EXCEEDED

For Auto, H3 Prompt Writer chooses the smallest 8K/16K context that fits the assembled
request. For a manual context, the error offers a larger setting but does not
silently rerun generation.

If 24K also cannot fit, reduce the number of references or use a larger-VRAM tier.

## Unsupported or oversized media

- Reference video and audio files must be 2 to 15 seconds long.
- Reference mode accepts at most 9 pictures, 3 videos, 3 audio files, and 12 total.
- A single uploaded file cannot exceed 1 GB.
- Audio is declared in the manifest but is not analyzed locally.

## Cancel or Unload appears delayed

Cancellation occurs at the next safe backend checkpoint. During a model constructor
call, the request may not stop instantly. If the GPU driver has frozen the Python
process, restart ComfyUI.

## Developer logs

Developer logging is off by default. To enable it for diagnosis, set
`H3PROMPTWRITER_DEV_MODE=1` before launching ComfyUI. Logs are written under the
local application data directory at `H3PromptWriter/logs/generations.jsonl` unless
`H3PROMPTWRITER_DEV_LOG_PATH` overrides the location.

Do not share a developer log without reviewing it: it may contain the full brief,
assembled request, and generated prompt.
