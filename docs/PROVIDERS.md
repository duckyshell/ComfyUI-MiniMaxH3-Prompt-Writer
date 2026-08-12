# Choose a provider

Not sure? Start with Ollama. It's the simplest local setup.

The provider determines how Writer reaches its prompt model. That prompt model reads the brief and references, then writes text. It is separate from the MiniMax H3 model in your video workflow. Tested Ollama tags are listed in the Ollama guide, and verified GGUF pairs are listed in the Direct guide.

Ollama, External llama.cpp, and API providers can use other multimodal models when the provider and model accept image inputs. Gemma 4 is the recommended local family and has received the most testing, but it is not a whitelist for those three provider paths. Compatibility does not guarantee the same H3 prompt quality. Direct GGUF is currently limited to the verified Gemma 4 pairs.

| Provider | Best for | Model runs | Extra setup |
| --- | --- | --- | --- |
| [Ollama](OLLAMA.md) | Most local users | Local Ollama service | Install Ollama and pull a vision model |
| [Direct GGUF](DIRECT_GGUF.md) | Advanced users who want the model inside ComfyUI | ComfyUI Python process | Optional `llama-cpp-python`, GGUF, and matching `mmproj` |
| [External llama.cpp](EXTERNAL_LLAMA_SERVER.md) | Maximum control over build, GPU placement, context, and KV cache | Your local `llama-server` | Start a multimodal server and connect its root URL |
| [API providers](API_PROVIDERS.md) | No local prompt-model runtime, or an existing OpenAI-compatible endpoint | Remote provider or your Custom server | API key for commercial providers; endpoint and model ID for Custom |

## Ollama

Choose Ollama if you want a local model without managing Python wheels, GGUF projector pairing, or llama.cpp build flags inside ComfyUI. Prompt Writer detects installed compatible vision models. Its built-in Gemma 4 list marks exact tags tested with H3; it is not a whitelist. Qwen 3.6 has also completed all five H3 modes through Ollama as a compatibility test, not a quality ranking.

Prompt Writer does not install or start Ollama, and it never pulls a model automatically.

## Direct GGUF

Choose Direct when you want Prompt Writer to load a verified Gemma 4 GGUF and its projector directly inside ComfyUI. This path exposes Context and KV cache controls and lets Writer manage model loading and unload.

Direct is optional. It depends on a native `llama-cpp-python` wheel, so compatibility is narrower than the other provider paths.

## External llama.cpp

Choose External if you already use llama.cpp or want your own current/custom build. Prompt Writer handles the H3 request and cancellation. Your server controls model loading, context, KV cache, GPU placement, optimizations, and server lifetime.

External has its own local provider path and is the recommended advanced alternative when the Direct Python runtime is incompatible with a system.

## API providers

Choose an API provider if you do not want a local prompt-model runtime. Gemini, OpenAI, and OpenRouter have presets. Custom accepts a generic OpenAI-compatible endpoint such as local LM Studio.

Remote providers receive the brief, H3 instructions, and enabled prepared visual inputs. Read [API providers](API_PROVIDERS.md#what-leaves-this-computer) before connecting a remote service.

Comfy Cloud has not been validated for v0.3.
