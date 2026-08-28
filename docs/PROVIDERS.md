# Choose a provider

Not sure? Start with Ollama. It's the simplest local setup.

The provider determines how Writer reaches its prompt model. That prompt model reads the brief and references, then writes text. It is separate from the MiniMax H3 model in your video workflow. Tested Ollama tags are listed in the Ollama guide, and verified GGUF pairs are listed in the Direct guide.

Provider setup can differ by host. Direct GGUF on this page means the ComfyUI extension path using `llama-cpp-python`. Standalone Local GGUF starts a user-selected `llama-server.exe` instead; see the [Standalone setup guide](../standalone/README.md#local-gguf).

Ollama, External llama.cpp, and API providers can use other multimodal models when the provider and model accept image inputs. Gemma 4 is the recommended local family and has received the most testing, but it is not a whitelist for those three provider paths. Compatibility does not guarantee the same H3 prompt quality.

External llama.cpp can also use a text-only model for requests without images or video. Direct GGUF supports its verified Gemma 4 pairs, a verified Qwen 3.8 configuration, and metadata-recognized custom configurations that remain labeled unverified.

| Provider | Best for | Model runs | Extra setup |
| --- | --- | --- | --- |
| [Ollama](OLLAMA.md) | Most local users | Ollama on this computer or another host | Install Ollama and pull a vision model |
| [Direct GGUF](DIRECT_GGUF.md) | Advanced users who want the model inside ComfyUI | ComfyUI Python process | Optional `llama-cpp-python`, GGUF, and matching `mmproj` |
| [External llama.cpp](EXTERNAL_LLAMA_SERVER.md) | Maximum control over build, GPU placement, context, and KV cache | Your local `llama-server` | Start the server; add a matching `mmproj` for images and video |
| [API providers](API_PROVIDERS.md) | No local prompt-model runtime, or an existing OpenAI-compatible endpoint | Remote provider or your Custom server | API key for commercial providers; endpoint and model ID for Custom |

## Ollama

Choose Ollama if you want a local model without managing Python wheels, GGUF projector pairing, or llama.cpp build flags inside ComfyUI. Prompt Writer detects installed compatible vision models. Its built-in Gemma 4 list marks exact tags tested with H3; it is not a whitelist. Qwen 3.6 has also completed all five H3 modes through Ollama as a compatibility test, not a quality ranking.

Prompt Writer does not install or start Ollama, and it never pulls a model automatically.

The default Ollama host is on this computer. If you choose a remote host, it receives the brief, instructions, and prepared visual inputs.

## Direct GGUF

Choose Direct when you want Prompt Writer to load a supported GGUF and optional matching projector directly inside ComfyUI. This path exposes managed runtime controls and lets Writer manage model loading and unload. Gemma 4 uses the established adapter. Qwen 3.8 and Qwen3-VL require `llama-cpp-python 0.3.35` or newer and use model-aware planning from 16K to 48K.

Direct is optional. It depends on a native `llama-cpp-python` wheel, so compatibility is narrower than the other provider paths.

## External llama.cpp

Choose External if you already use llama.cpp or want your own current/custom build. Prompt Writer handles the H3 request and cancellation. Your server controls model loading, context, KV cache, GPU placement, optimizations, and server lifetime.

External has its own local provider path and is the recommended advanced alternative when the Direct Python runtime is incompatible with a system.

A text-only server works with Music 3, T2VA, and Refine. Add the model's matching `mmproj` when Writer needs to read images or video.

## API providers

Choose an API provider if you do not want a local prompt-model runtime. Gemini, OpenAI, and OpenRouter have presets. Custom accepts a generic OpenAI-compatible endpoint such as local LM Studio.

Remote providers receive the brief, H3 instructions, and prepared visual inputs from the current mode's manifest. Read [API providers](API_PROVIDERS.md#what-leaves-this-computer) before connecting a remote service.

Comfy Cloud has not been validated for v0.3.
