# Ollama

Ollama is the recommended local provider. It keeps the prompt-model runtime outside ComfyUI and avoids the optional Direct GGUF Python wheel.

![Ollama setup in H3 Prompt Writer](assets/v0.3/ollama-setup.png)

## Quick setup

1. [Install Ollama](https://ollama.com/download) and open the Ollama app.
2. Choose a starting model for your GPU from the table below.
3. Run its `ollama pull` command in Terminal, PowerShell, or Command Prompt.
4. Open **H3 Prompt Writer > Settings > Ollama**.
5. Select **Check now** if the app is waiting for Ollama to start.
6. After the pull completes, select **Refresh**, choose the installed model, and return to Generate.

Prompt Writer only checks the selected Ollama service and its installed models. It does not start `ollama serve`, call `/api/pull`, or download models.

## Ollama on another computer

The default host is `http://127.0.0.1:11434`. To use Ollama on another computer, open the collapsed **Use Ollama on another computer** control in Ollama Settings and enter that server's root URL, such as `http://192.168.1.25:11434`.

The Ollama server must listen on the network and allow connections from the ComfyUI computer. Pull commands must be run on the computer that hosts Ollama. Writer remembers the selected model separately for each host.

Plain HTTP is allowed only for this computer or a private LAN IP. Public remote hosts must use HTTPS. Writer rejects cloud metadata and special network addresses.

## Tested Gemma 4 tags

These are starting recommendations, not guaranteed minimum requirements:

| GPU tier | Tested tag | Command |
| --- | --- | --- |
| Less than 8 GB | `gemma4:e2b` | `ollama pull gemma4:e2b` |
| 8 GB | `gemma4:e4b` | `ollama pull gemma4:e4b` |
| 12-16 GB | `gemma4:12b` | `ollama pull gemma4:12b` |
| 24 GB | `gemma4:26b` | `ollama pull gemma4:26b` |
| 32 GB | `gemma4:31b` | `ollama pull gemma4:31b` |

All five exact tags completed H3 multimodal validation. The measurements were taken on a 32 GB RTX 5090. Actual headroom depends on display use, ComfyUI models, other applications, context size, and Ollama's GPU/CPU placement.

The Writer marks these exact tags **Tested for H3**. Other installed vision models can still appear when Ollama reports compatible capabilities; they are shown as compatible but not H3-tested.

Qwen 3.6 also completed all five H3 modes through Ollama without special changes to Writer. It is not part of the fixed GPU table because those starting tiers come from the measured Gemma 4 runs.

You can try other Ollama vision models when Ollama reports the required image capability. This is an option for experimentation, not a promise that every multimodal model will follow the H3 format equally well.

## Context and Thinking

Leave **Context (tokens)** empty for Auto. Writer estimates the assembled request and selects 8K, 16K, or 24K. To use less memory or fit a larger Sequence, enter an exact token count, including values above 24K. Writer sends it as `num_ctx` and checks that the input and reply fit within it and that it respects the model's reported limit. Ollama controls KV cache and GPU/CPU placement.

The **Thinking** switch is available only when the selected Ollama model reports thinking support. When enabled, Auto reserves the larger reasoning and final-output budget before choosing context.

## Model lifecycle

With **Keep model loaded** off, Writer asks Ollama to unload the model after the request. Turn it on when generating several prompts in a row.

- **Unload Ollama** releases an idle Ollama model retained by Writer.
- **Stop & unload** cancels an active Ollama request and asks Ollama to unload that model.
- **Cancel** stops the current request without changing a previously retained model.

Ollama is a shared service. Writer only offers unload controls for models it intentionally used and retained during the current Writer session. Retained-model state is tracked separately for each configured host.

See [Troubleshooting](TROUBLESHOOTING.md#ollama-is-not-running) if the service or model is not detected.

**Generation budget** in Settings sets the output token limit, including thinking.
Auto keeps the default budget. Choose a preset or Custom when a response reaches
its limit. The input, reply budget, and safety reserve must fit the context.
