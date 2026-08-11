# Model adapters

The local adapter uses llama-cpp-python/GGUF for Gemma 4 images and ordered video
contact sheets, including projector validation and CUDA offload.

`gguf_backend.py` owns local llama-cpp-python loading, tokenization,
cancellation, and unloading. `external_server_backend.py` independently owns
the specialized local llama.cpp HTTP/SSE connection. `ollama_backend.py` owns
the native Ollama contract. `api_provider_backend.py` owns one generic Chat
Completions transport with OpenAI, Gemini, OpenRouter, and Custom presets.

All backends supply a narrow `complete(...)` callable to `backend/h3_pipeline.py`.
The pipeline owns shared media messages, Thinking fallback, prompt audit, narrow
repair, and normalized generation metrics. It does not own provider preflight,
transport, or lifecycle.

The extension does not install the full Unsloth runtime. Unsloth GGUF files are
loaded directly with llama.cpp. `requirements-gguf.txt` installs the adapter.

Audio files remain declared references. The local adapter does not analyze their
signal and must not infer unheard content.

`external_server_backend.py` uses the same request assembly, contact sheets,
prompt audit, and narrow repair pipeline while sending chat completions to an
already-running local OpenAI-compatible `llama-server`. It does not inherit from
the Direct GGUF backend. The remote process owns model loading, context, KV
cache, and unloading; the adapter never stops or unloads that process.

`api_provider_backend.py` keeps credentials in backend memory or reads them from
an environment variable. Browser storage receives only non-secret connection
configuration. The shared transport handles HTTPS/loopback HTTP, SSE, usage,
best-effort cancellation, and normalized errors. Presets only map endpoint,
output-token, reasoning, model metadata, and disclosure differences; they are
not separate backends. Custom remains generic OpenAI-compatible and does not use
llama.cpp `/health`, `/props`, context, KV, or lifecycle semantics.

Gemini exposes its official Minimal/Low/Medium/High reasoning choice in the
Gemini preset and owns the combined reasoning/output budget. Other API presets
do not expose the app's local Thinking toggle. A loopback Custom endpoint is
optionally enriched from LM Studio's `/api/v1/models` metadata when that exact
shape is available; this enables reported vision/context capabilities and
suppresses LM Studio's default hidden reasoning without turning Custom into a
separate backend.
