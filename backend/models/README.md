# Model adapters

The local adapter uses llama-cpp-python/GGUF for Gemma 4 images and ordered video
contact sheets, including projector validation and CUDA offload.

`gguf_backend.py` owns local llama-cpp-python loading, tokenization,
cancellation, and unloading. `external_server_backend.py` independently owns
the local HTTP/SSE connection and never implements local model lifecycle hooks.

Both backends supply a narrow `complete(...)` callable to `backend/h3_pipeline.py`.
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
