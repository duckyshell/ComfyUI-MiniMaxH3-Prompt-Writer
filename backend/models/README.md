# Model adapters

The local adapter uses llama-cpp-python/GGUF for Gemma 4 images and ordered video
contact sheets, including projector validation and CUDA offload.

The adapter exposes load, generate, unload, and capability reporting through one contract.

The extension does not install the full Unsloth runtime. Unsloth GGUF files are
loaded directly with llama.cpp. `requirements-gguf.txt` installs the adapter.

Audio files remain declared references. The local adapter does not analyze their
signal and must not infer unheard content.

`external_server_backend.py` reuses the same request assembly, contact sheets,
prompt audit, and narrow repair pipeline while sending chat completions to an
already-running local OpenAI-compatible `llama-server`. The remote process owns
model loading, context, KV cache, and unloading. The adapter never stops or
unloads that process.
