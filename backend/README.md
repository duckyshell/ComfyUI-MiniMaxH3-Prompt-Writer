# Backend

The extension exposes direct ComfyUI routes under `/h3studio` and registers
`ComfyUI/models/LLM/` through ComfyUI's folder-path mechanism.

Responsibilities:

- `/status`, `/models`, `/generate`, `/cancel`, `/unload`, and `/refine` routes;
- session media upload/list/remove/manifest routes;
- normalized image previews and configurable uniform video contact sheets;
- MiniMax guide loading and request assembly;
- generation orchestration, lifecycle, status, cancellation, and structured errors;
- backend-neutral model adapters in `models/`.

Generation dispatches metadata-recognized Gemma 4, `qwen35`, `qwen35moe`,
`qwen3vl`, and `qwen3vlmoe`
GGUF models to the llama-cpp-python adapter. Unknown architectures remain
discoverable for diagnostics but are not marked runtime-ready.
Generation and text-only refinement use the same request and response contract.
