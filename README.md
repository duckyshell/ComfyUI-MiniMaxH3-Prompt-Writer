# ComfyUI MiniMax H3 Prompt Writer

<p align="center">
  <img src="web/assets/h3-prompt-writer-launcher.svg" width="96" alt="H3 Prompt Writer">
</p>

Current release: **0.4.1** | [MIT License](LICENSE)

H3 Prompt Writer is a prompt-writing workspace for MiniMax H3 inside ComfyUI. Start with a plain-language Creative Brief, add optional image, video, or audio references, and generate an editable prompt in the format expected by H3.

It is a ComfyUI UI extension, not a workflow node. It writes prompt text for your existing H3 workflow. It does not run MiniMax H3, change the graph, or queue a video.

## What's new in v0.4.0

- Added Qwen 3.8 support for Direct GGUF, including vision references and optional Thinking.
- Added support for compatible Qwen 3.8 fine-tunes and Qwen3-VL models.
- Reference assets can now be replaced without changing their position in the list.
- Improved automatic context selection for large prompts and prompts with many references.
- Improved Direct GGUF stability, memory handling, and tokenizer reliability.

## What's new in v0.3

- Redesigned Writer and Settings interface.
- Ollama as a simpler local setup.
- Optional API providers.
- External llama.cpp now has its own dedicated provider setup.
- Saved drafts for every mode.
- Better automatic model and context handling.
- More reliable Reference prompts.

![Reference mode in H3 Prompt Writer](docs/assets/v0.3/reference-workspace.png)

## What it does

You do not need to write MiniMax section headings, timestamps, or reference syntax by hand. Describe the video and tell Writer what each reference should contribute:

```text
Use <Picture 1> for character appearance, <Picture 2> for clothes, and only the movement from <Video 1>. The character walks through a rainy Tokyo street at night.
```

Writer sends your brief, selected mode, prepared references, and the official MiniMax prompt-writing guide to the chosen prompt model. The result is an editable H3 prompt. You can change it directly, use **Refine** for a revision, or select **Copy prompt** and paste it into your H3 workflow.

## Key features

- T2VA, I2VA, FL2VA, L2VA, and Reference modes.
- Up to 9 images, 3 videos, and 3 audio references in Reference mode.
- Clear `<Picture N>`, `<Video N>`, and `<Audio N>` labels for assigning identity, wardrobe, setting, motion, camera, sound, or other roles.
- In-place Reference media replacement from the asset menu or by dropping one file directly on a card, without rebuilding the surrounding asset order.
- Ordered video contact sheets with visible frame-sampling controls, so you can inspect what the prompt model sees.
- Official MiniMax base and Reference guides included for all five modes.
- Editable prompts, **Refine**, **Copy prompt**, and a separate saved draft for every mode.
- Automatic context planning and clear controls for releasing local prompt models and ComfyUI VRAM.

See [Writing a useful Creative Brief](docs/USAGE.md#writing-a-useful-creative-brief) for practical examples.

## Choose a provider

| Provider | Choose it when | Setup |
| --- | --- | --- |
| [Ollama](docs/OLLAMA.md) | You want the simplest local setup | Install Ollama and pull a vision model |
| [Direct GGUF](docs/DIRECT_GGUF.md) | You want Writer to load a supported GGUF inside ComfyUI | Install the optional native runtime and add a matching GGUF + `mmproj` pair |
| [External llama.cpp](docs/EXTERNAL_LLAMA_SERVER.md) | You already run llama.cpp or want full control over its runtime | Start `llama-server`; add a matching `mmproj` for images and video |
| [API providers](docs/API_PROVIDERS.md) | You want Gemini, OpenAI, OpenRouter, or a Custom OpenAI-compatible endpoint | Connect a key or an existing endpoint such as LM Studio |

Not sure? Start with [Ollama](docs/OLLAMA.md). The [provider guide](docs/PROVIDERS.md) explains the differences. The Ollama and Direct GGUF guides contain the tested local model choices.

## Quick start

1. Install **MiniMax H3 Prompt Writer** from ComfyUI Manager and restart ComfyUI.
2. Open the floating **H3 Prompt Writer** button or use **Extensions > H3 Prompt Writer**. No graph node will appear.
3. Open **Settings** and choose a provider. For the recommended local setup and an 8 GB starting tier, install [Ollama](https://ollama.com/download), open the app, and run:

   ```text
   ollama pull gemma4:e4b
   ```

4. Choose a mode, add its media, and write a Creative Brief.
5. Select **Generate prompt**, review the editable result, then copy it into your H3 workflow.

For Git, ZIP, Windows Portable, update, and provider-specific steps, see [Installation](docs/INSTALLATION.md).

## Privacy and limitations

- With Ollama, Direct GGUF, External llama.cpp, or a local Custom endpoint, the prompt request and prepared media stay on the local machine.
- With a remote API provider, the required brief, instructions, prepared images, and video contact sheets are sent to the selected provider. Original video and audio bytes are not uploaded by Writer. Read [What leaves this computer](docs/API_PROVIDERS.md#what-leaves-this-computer) before using private media.
- Video understanding uses the ordered contact sheet shown in the preview, not every frame of the encoded video.
- Prompt models do not listen to uploaded audio. Describe the soundtrack, voice, rhythm, or other audio role in the Creative Brief.
- The interface and documentation are in English. Briefs can use other languages, and Writer preserves supplied dialogue and visible text.
- Gemma 4 remains the simplest tested local choice. Direct GGUF also supports Qwen 3.8, compatible Qwen 3.8 fine-tunes, and Qwen3-VL. Untested compatible models may behave differently from the verified pairs.
- Ollama, External llama.cpp, and compatible API endpoints let you try other multimodal models that accept images. Compatibility does not guarantee a good H3 prompt.
- External llama.cpp also accepts text-only models for Music 3, T2VA, and Refine. Image and video requests still need a vision model.
- Direct GGUF supports Gemma 4, Qwen 3.8, compatible Qwen 3.8 fine-tunes, and Qwen3-VL. The tested Qwen 3.8 and Qwen3-VL model and projector pairs are marked as verified. Other compatible combinations are marked as unverified. A missing projector leaves text-only T2VA available.
- Gemini and a Custom OpenAI-compatible endpoint were tested live. OpenAI and OpenRouter have automated contract coverage but were not tested live with commercial credentials. Comfy Cloud has not been validated for v0.3.

## Documentation

- [Installation](docs/INSTALLATION.md)
- [Using Prompt Writer](docs/USAGE.md)
- [Choose a provider](docs/PROVIDERS.md)
- [Ollama](docs/OLLAMA.md)
- [Direct GGUF](docs/DIRECT_GGUF.md)
- [External llama.cpp](docs/EXTERNAL_LLAMA_SERVER.md)
- [API providers](docs/API_PROVIDERS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Changelog](CHANGELOG.md)

The project is released under the [MIT License](LICENSE). MiniMax H3 guides and model files keep their upstream terms. Model weights are not bundled with this extension.
