# Installation

H3 Prompt Writer is a ComfyUI UI extension. It does not add a node to the workflow graph.

## Install the extension

### ComfyUI Manager

Find **MiniMax H3 Prompt Writer** in ComfyUI Manager, install it, and restart ComfyUI.

### Git

Open a terminal in `ComfyUI/custom_nodes` and run:

```powershell
git clone https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer.git
```

### ZIP

Use **Code > Download ZIP** on GitHub. Extract the archive under `ComfyUI/custom_nodes` and, if needed, rename the folder to:

```text
ComfyUI-MiniMaxH3-Prompt-Writer
```

The final path should be:

```text
ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-Prompt-Writer/
```

The base extension has no additional Python dependencies. Provider-specific software is installed separately.

## Open Prompt Writer

Restart ComfyUI after installation. Open the floating **H3 Prompt Writer** button or use **Extensions > H3 Prompt Writer** in the ComfyUI menu.

No node will appear in the graph. Prompt Writer creates text for your H3 workflow; it does not queue or modify the workflow itself.

## Choose a provider

Open **Settings** and choose how Prompt Writer should run its multimodal prompt model:

- [Ollama](OLLAMA.md): recommended local setup.
- [Direct GGUF](DIRECT_GGUF.md): advanced local setup inside ComfyUI.
- [External llama.cpp](EXTERNAL_LLAMA_SERVER.md): connect your own local `llama-server`.
- [API providers](API_PROVIDERS.md): Gemini, OpenAI, OpenRouter, or a Custom OpenAI-compatible endpoint.

Not sure which one to use? Start with [Ollama](OLLAMA.md).

The model selected here is the prompt model that reads the brief and references. It is separate from the MiniMax H3 model in your video workflow. The [Ollama](OLLAMA.md) and [Direct GGUF](DIRECT_GGUF.md) guides contain the tested local model choices.

## Update

Update the extension through ComfyUI Manager or pull the latest repository changes, then restart ComfyUI and hard-refresh the page with `Ctrl+F5` if the interface still looks old.

An ordinary official `update_comfyui.bat` update was tested with Direct GGUF and preserved its optional runtime. An update that replaces the embedded Python environment can require reinstalling that runtime. See [Direct GGUF after a ComfyUI update](DIRECT_GGUF.md#after-a-comfyui-update).

Your saved provider preferences and per-mode drafts remain in the browser where ComfyUI is opened. API keys, uploaded media, active requests, and loaded-model state are not restored as saved session content.

Local providers keep the prompt request and prepared media on the local machine. A remote API provider receives the request data and prepared media needed to generate the prompt. See [What leaves this computer](API_PROVIDERS.md#what-leaves-this-computer).

See [Troubleshooting](TROUBLESHOOTING.md) if the launcher or selected provider is not ready.
