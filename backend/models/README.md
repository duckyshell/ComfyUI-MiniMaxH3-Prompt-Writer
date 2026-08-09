# Model adapters

The local adapter uses llama-cpp-python/GGUF for Gemma 4 images and ordered video
contact sheets, including projector validation and CUDA offload.

The adapter exposes load, generate, unload, and capability reporting through one contract.

The extension does not install the full Unsloth runtime. Unsloth GGUF files are
loaded directly with llama.cpp. `requirements-gguf.txt` installs the adapter.

Audio files remain declared references. The local adapter does not analyze their
signal and must not infer unheard content.
