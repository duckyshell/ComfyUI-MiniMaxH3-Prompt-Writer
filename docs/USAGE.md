# Usage

## Generate a prompt

1. Open the floating **H3 Prompt Writer** launcher. You can also use
   **Extensions > H3 Prompt Writer** from the ComfyUI menu.
2. Select T2VA, I2VA, FL2VA, L2VA, or Reference.
3. Add the media required by that mode.
4. Set target duration and aspect ratio.
5. Describe the intended result in **Creative brief**.
6. Select a ready local model and press **Generate prompt**.
7. Review or edit the result, then press **Copy prompt**.

H3 Prompt Writer calls its local ComfyUI routes directly. It does not queue or modify a
workflow.

## Modes

| Mode | Inputs |
| --- | --- |
| T2VA | Text brief only |
| I2VA | One opening picture |
| FL2VA | Opening and closing pictures |
| L2VA | One closing picture |
| Reference | Up to 9 pictures, 3 videos, 3 audio files; 12 total |

Reference tags use the official MiniMax notation: `<Picture N>`, `<Video N>`, and
`<Audio N>`. Reordering media renumbers references within each media type.

## Video references

Click a video card to open its preview. **What the model sees** shows the exact
ordered contact sheet sent to the local Gemma model.

- Auto uses 8 uniformly sampled frames.
- 6 and 8 are explicit frame-count choices.
- First & last controls endpoint inclusion.
- Resample keeps the selected settings and chooses a fresh uniform sample.

The contact sheet is an internal representation of the same `<Video N>` reference;
it never becomes a separate picture reference.

## Audio references

The local GGUF model does not listen to audio content. Audio remains in the media
manifest so the final MiniMax prompt can reference it. State the intended role in
the brief, for example:

```text
Use <Audio 1> as the complete soundtrack.
Use only the rhythm of <Audio 2> as an audio reference.
```

Audio content is not inferred locally. State any transcript, music style, or
sound details explicitly in the brief.

## Refine

**Refine** rewrites the current generated prompt using a short revision note. It
reuses the text context from the first pass and does not upload visual media again.
The previous prompt can be restored after a successful rewrite.

## Advanced runtime

Ordinary use should stay on Auto. Advanced users can select:

- Context: Auto, 8K, 16K, or 24K.
- KV cache: Auto, Q8, or F16.
- System Prompt: the additional H3 Prompt Writer instruction only. Official MiniMax
  guides remain read-only and are applied separately.

A manual context choice is never silently overridden. If the request does not fit,
H3 Prompt Writer offers an explicit larger-context action.

## Model lifecycle

- **Cancel** stops the active generation at the next safe checkpoint.
- **Keep model loaded** is off by default, so VRAM is released after each prompt.
  Enable it when creating several prompts in sequence.
- The footer memory action follows the active stage: **Free ComfyUI VRAM** unloads
  workflow models without clearing cached node results; **Unload prompt model**
  releases a kept-loaded Gemma model; during generation **Stop & unload** requests
  a safe cancel followed by unload.
- Before loading a tested model tier, H3 Prompt Writer compares currently free VRAM with its
  measured runtime estimate. If workflow models occupy too much memory, the error
  offers **Free ComfyUI VRAM & retry**. The measured preflight applies only to the
  listed model tiers; other files use normal runtime error handling.
