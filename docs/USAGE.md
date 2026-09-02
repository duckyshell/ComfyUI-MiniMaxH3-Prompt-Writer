# Usage

## Generate a prompt

1. Open the floating **H3 Prompt Writer** button or use **Extensions > H3 Prompt Writer**.
2. Choose a mode.
3. Add the media required by that mode.
4. Set duration and aspect ratio.
5. Describe the intended video in **Creative Brief**.
6. Choose a ready prompt model in **Settings**.
7. Select **Generate prompt**.
8. Review or edit the generated prompt, then select **Copy prompt** and paste it into your H3 workflow.

Prompt Writer creates text. It does not add nodes, modify the graph, or queue a video workflow.

Use the fullscreen button in the Writer header when you want the workspace to fill the browser. Press Escape to leave fullscreen.

![Reference mode with a generated prompt](assets/v0.3/reference-workspace.png)

## H3 Continuum sequences

**H3 Continuum** is an output target for the five H3 Video modes. It is not a sixth mode. Choose the underlying T2VA, I2VA, FL2VA, L2VA, or Reference mode first, then select **H3 Continuum** under **Output target**.

Set **Chunks** from 1 to 16 and **Seconds per chunk** from 4 to 30; 5 to 15 seconds remains the upstream recommended and validated range. Writer shows their total duration but sends the native per-chunk duration to H3. For example, 8 chunks at 6 seconds is a 48-second sequence.

Sequence generation is staged:

1. Writer creates and validates one semantic continuity plan for the complete sequence. The model writes sequence-wide H3 prose in `global.sequence_preamble`, while Writer owns chunk count, exact time boundaries, and public downstream reference identities.
2. Writer generates each chunk-local H3 prompt in order. Continuous chunks receive the previous terminal state and previous chunk prompt; an intentional cut or reset is allowed only when the plan marks an explicit `intentional_break`. Chunk bodies use Continuum-native prose rather than standalone I2VA/FL2VA/L2VA/Reference wrappers. The dedicated authoring contract keeps the format-safe H3 rules: grounded visible/audible progression, natural camera motion, stable speaker IDs, exact `<d>[Language] ...</d>` dialogue, verbatim visible text, requested-only music, and exclusive reference-role transfer. Absolute sequence timing belongs to the outer Timeline headers.
3. Writer serializes one canonical Continuum Timeline. Persistent H3 prose appears before the first section header, then every chunk body appears below its exact `[start-end]` header.

For three 5-second chunks, the shape is:

```text
Persistent sequence-wide H3 identity, reference, wardrobe, environment, style, camera, lighting, audio, and exclusion rules.

[0-5s]
Chunk-local H3 prompt for the first span.

[5-10s]
Chunk-local H3 prompt continuing from the first span.

[10-15s]
Chunk-local H3 prompt continuing from the second span.
```

The header must be on its own line. Writer computes integer and fractional boundaries deterministically from **Seconds per chunk**; a 6.5-second sequence therefore uses `[0-6.5s]`, `[6.5-13s]`, `[13-19.5s]`, and so on. Writer does not depend on Continuum's parser fallback to reinterpret malformed text.

The plan keeps subject identity, wardrobe, environment, camera axis, lighting, sound, dialogue, visible text, constraints, and reference roles stable. Prompt models are probabilistic, so review the sequence; Writer validates structure and stable identifiers but cannot guarantee perfect visual continuity from the video model.

Install [ComfyUI H3 Continuum](https://github.com/ukr8b3g-cmyk/ComfyUI-H3-Continuum) and use a supported **H3 Continuum Sampler V3.4–V3.7** (V3.7 is the current upstream release). Connect a **Text (Multiline)** node to the sampler's **Sequence Prompt** input. **Apply to Continuum** requires **Prompt Format = Timeline** and writes the canonical sequence into that connected text widget. If more than one compatible sampler exists, select exactly one on the canvas first. If Prompt Format, chunk count, or chunk duration differs, Writer shows every mismatch and offers an explicit **Sync settings & apply** action. That action changes only those sampler settings and the connected text value; it does not add or rewire nodes.

### Continuum references and keyframes

Before a Continuum generation or refinement request, Writer requires a compatible H3 Continuum V3.4–V3.7 sampler in the current workflow, inspects its active conditioning inputs, and derives the same public identities that H3 Continuum presents to MiniMax. If no compatible sampler exists, Writer stops before contacting the prompt model; it does not invent an empty reference topology. The backend enforces the same contract, so direct Continuum API requests must include the downstream inventory explicitly; an empty inventory means the inspected sampler genuinely has no active conditioning inputs.

When one or more **Reference Image** sockets are active, those Reference Images own the public Picture namespace in active connection order, compacted to `<Picture 1>` through `<Picture N>`. Gaps in physical socket numbers do not create gaps in public numbering. In these hybrid runs, connected **First Frame** and **Last Frame** remain temporal keyframes and do not receive separate public Picture tags.

Writer also checks the selected mode against the sampler's conditioning topology before generation, refinement, and graph handoff. T2VA requires no First/Last keyframe and no active Reference Image input; Reference Images without temporal keyframes are H3 Continuum Reference conditioning, not T2VA. I2VA requires First Frame only, FL2VA requires both First and Last Frame, and L2VA requires Last Frame only. Reference mode remains hybrid-capable: Reference Images can coexist with either or both keyframes. Reference Images augment I2VA/FL2VA/L2VA rather than changing those keyframe modes.

When no Reference Image socket is active, connected temporal keyframes own the compact Picture namespace instead: **First Frame** is `<Picture 1>`; **Last Frame** is the next active Picture identity, so FL2VA uses `<Picture 1>` for the opening and `<Picture 2>` for the ending, while L2VA uses `<Picture 1>` for its sole final keyframe. In a multi-chunk sequence, an opening-keyframe tag is valid only in Chunk 1 and a final-keyframe tag is valid only in the final chunk; neither belongs in the shared preamble. Persistent Reference Image tags remain valid across chunks.

**Video Reference** owns the persistent public tag `<Video 1>`. On V3.5 and newer, **Reference Audio** owns persistent `<Audio 1>` and can be used in the shared preamble and every chunk. **Driving Audio** is a different contract: it is persistent downstream conditioning and owns no `<Audio N>` prompt tag. V3.7's optional **Still Image Guide** also owns no public prompt tag. Writer validates these scopes in the semantic plan, generated chunk, and chunk-refinement paths.

The downstream workflow inventory and the prompt model's visible media are separate contracts. A connected Reference Image can be declared as `<Picture 1>` even when its pixels were never uploaded to Prompt Writer or Qwen. In that case Writer tells the planner that the reference exists and is not model-visible, and the model must not invent its appearance. State the intended role in the Creative Brief, for example `Use <Picture 1> for the subject identity`.

Prompt Writer media is never assumed to be the same downstream reference merely because both would otherwise be called `<Picture 1>`. Unverified uploaded media is labeled as analysis media for the prompt model instead of silently taking a downstream public identity.

When [Image Conveyor](https://github.com/xmarre/ComfyUI-Image-Conveyor) feeds the selected Continuum sampler, Writer resolves Conveyor's effective output contract rather than treating every saved wire as active. In **Reference + H3 Continuum**, the Media panel contains an **Active workflow images** section. **Add active workflow refs** copies each stable, active Conveyor Reference Shelf image (and direct Load Image source) into the temporary Prompt Writer media session, marks that downstream item `visible_to_model`, and binds the copied asset to the same public `<Picture N>`/conditioning role. This is the control to use when the prompt model must actually inspect the reference pixels instead of merely knowing that the downstream slot exists. In **Persistent references** mode, only populated Reference Shelf slots whose matching output switch is enabled can become Reference Images; disabled or empty shelf outputs are excluded even if their wires remain visible. The independent Main and Last Frame switches likewise determine whether Conveyor-backed temporal keyframes are active, including through a single-image transform chain or bypass node. Persistent shelf Reference Images receive an opaque local source fingerprint in the saved inventory, so replacing a shelf image is detected as source drift even when the graph wire does not change; filenames are not stored in that fingerprint. Sequences saved before this fingerprint existed are accepted as legacy-unknown on their first compatible use and adopt the current fingerprint after a successful refinement, avoiding an upgrade-only false drift. In **Queue execution group** mode, Writer follows **Images per execution** exactly: `image` is group image 1, `ref_image_1` through `ref_image_8` expose subsequent group members, and `last_frame` aliases group image 2. Queue members remain intentionally dynamic and are not content-fingerprinted. Because their concrete file is selected at queue time, queue-group and other queue-driven outputs are shown as dynamic and are not falsely imported as stable Prompt Writer media. For the reviewed `ImageScaleToTotalPixelsX` implementation from **Scale Image to Total Pixels Adv**, Writer can materialize a stable Conveyor Reference Shelf or direct Load Image source through static `megapixels`, `multiple_of`, `stretch/crop/pad`, and **Lanczos** settings. The transform parameters are part of the saved source fingerprint, so changing 0.70→0.80 MP, the multiple, resize mode, or source image produces **Update needed**. Any connected runtime override for width, height, megapixels, multiple-of, resize mode, or interpolation, plus non-Lanczos interpolation, animated files, further arbitrary processing chains, and other transforms stay unavailable rather than pretending a stale widget or pre-transform source matches H3. After a transformed reference is added, its workflow row previews the post-transform Writer asset that the prompt model actually sees. **Don't consume** changes queue reuse, not the public conditioning topology.

A text-only Direct GGUF can therefore write I2VA, FL2VA, L2VA, or Reference **Continuum** prompts when all visual conditioning is workflow-only. If you attach Prompt Writer images or video for the model to inspect during initial generation, a matching vision projector is still required. Chunk refinement does not re-upload those media, so a saved Continuum sequence can remain in its original mode and be refined with a text-only Direct model even when the earlier analysis media is still attached.

For a local change, open **Refine**, select one Timeline section, and describe the revision. Writer regenerates only that chunk body and preserves the shared preamble and every other body byte-for-byte. H3 Continuum Run Storage hashes each **resolved prompt** after the Timeline preamble has been prepended. A local Chunk 3 edit therefore preserves earlier resolved hashes; changing the shared preamble changes every resolved hash. Writer treats shared-preamble changes as sequence-wide changes and requires regeneration rather than disguising them as a chunk-local edit.

Legacy Prompt Writer drafts using strict, contiguous `[Chunk N]` sections can be migrated into Timeline form. New production output and graph handoff use Timeline only.

The target, settings, validated plan, shared preamble, chunk bodies, resolved hashes, manual draft, and normalized downstream H3 Continuum conditioning inventory are saved with the current mode. On later refinement or graph handoff, Writer compares that snapshot with the active sampler and stops if an observable reference/keyframe source changed while keeping the same public tag. Legacy drafts without a snapshot remain readable and adopt the active inventory after a successful chunk refinement. API credentials are not part of that saved state.

## Modes

| Mode | Input | How the media is used |
| --- | --- | --- |
| T2VA | Creative Brief only | Writer builds the full audiovisual timeline from text |
| I2VA | One opening image | `<Picture 1>` is the first frame |
| FL2VA | Opening and closing images | `<Picture 1>` is the first frame and `<Picture 2>` is the last frame |
| L2VA | One closing image | `<Picture 1>` is the last frame |
| Reference | Up to 9 images, 3 videos, and 3 audio files; 12 files total | Each active file can provide a specific subject, setting, motion, camera, style, or sound role |

Duration and aspect ratio become part of the request. The generated text remains editable before you copy it.

## Music 3

Music 3 is a separate workspace for the MiniMax Music 3 model. It writes structured music captions and does not generate H3 video prompts.

Describe the intended sound, vocals, mood, arrangement, and production in **Music Brief**. **Lyrics** is optional. After generation, copy **Generated Caption** to the workflow **Caption** input and pass the original **Lyrics** to the workflow **Lyrics** input.

Use **Refine** under Lyrics to create Lyrics from an empty field or rewrite the current text. Write one instruction for either task. **Use Music Brief** is on by default, so the request can follow the current brief. Turn it off when only the Lyrics and instruction should be sent.

Lyrics change only after a complete response. Cancelling or receiving an error keeps the current text. After a successful request, **Remove generated** returns an empty Lyrics field when the request started empty, while **Restore previous** returns the earlier Lyrics after a rewrite. The instruction stays in the Refine block so you can adjust and reuse it.

Caption Refine uses the current Music Brief, current Lyrics, current caption, and refine instruction. It does not use an older saved copy of the brief or Lyrics.

Music 3 keeps its own saved Music Brief, Lyrics, and edited caption. Open **System prompt** to edit two separate profiles: **Caption** for structured captions and **Lyrics** for creating or rewriting Lyrics. A custom prompt replaces that profile's complete built-in prompt. **Restore default** returns only that profile to its built-in prompt.

## Writing a useful Creative Brief

Write what should happen in ordinary language. You do not need to reproduce the official H3 prompt format. Writer builds that structure for you.

Video Creative Briefs can contain up to 8,000 characters. Music Briefs keep their separate 2,000-character limit.

A useful brief usually says:

- what happens in the video;
- which reference supplies each important detail;
- what must stay unchanged;
- any exact dialogue, visible text, music, or sound;
- which details from a reference must not transfer.

### T2VA example

T2VA has no media, so describe the scene, action, camera, and sound directly:

```text
A tired baker opens a small street bakery before sunrise. Use one continuous slow push-in as he places the first loaf on the counter and says, "First batch of the morning." Quiet street ambience, wooden shutters and a single doorbell. No background music.
```

### I2VA example

The uploaded image is already the opening frame. Describe what happens next instead of restating every visible detail:

```text
Continue naturally from <Picture 1>. The woman notices a paper boat floating past her feet, follows it along the wet pavement and kneels to pick it up. Keep her appearance, clothes and the evening lighting unchanged. The camera slowly pulls back without a cut.
```

### Reference example

Assign a clear role to each file when several references are active:

```text
Use <Picture 1> for the character's face and hair. Use <Picture 2> only for clothes and <Picture 3> for the rainy tram-stop setting. Use only the slow lateral camera movement and pacing from <Video 1>; do not copy its performer, clothes, background, lighting or audio. The character waits alone, notices an approaching light and turns into the wind. End on a quiet close-up.
```

The roles can be short. Phrases such as `use for appearance`, `clothes only`, `background`, `movement only`, `camera motion only`, and `keep the visible text exactly` are enough when the intent is clear.

Every active picture and video in Reference mode belongs to the request. It does not need to become a main subject, but Writer expects the generated prompt to account for it. Uploaded audio remains available in the manifest without automatically becoming part of the prompt. During Generate, an exact canonical tag in the Creative Brief, such as `<Audio 1>`, makes that audio reference required.

### Audio example

Prompt models do not hear the audio file, so describe what should be taken from it:

```text
Use <Audio 1> as the full soundtrack: slow solo piano with three soft notes followed by a long pause. Use <Audio 2> only as a reference for the narrator's low, breathy voice. Do not copy any words from it.
```

Include a transcript when exact speech or lyrics matter. Writer preserves user-supplied dialogue and visible text rather than asking the prompt model to guess them.

## Images and video

Images are sent to the selected multimodal model in reference order. Reordering media renumbers tags within each type.

In Reference mode, select **Replace** on an asset card or drop one new file on the card. The new file keeps the same position in the list. It can be a different media type, so check any Picture, Video, or Audio tags in your brief after replacing it. Dropping several files on a card adds them to the end of the list instead.

For video, Writer prepares an ordered contact sheet. Open a video card to inspect **What the model sees** and choose the available frame-sampling options. The contact sheet still represents the same `<Video N>` reference; it does not create extra `<Picture N>` tags.

Local providers and remote API providers use the prepared contact sheet instead of the original encoded video stream. API providers can receive the derived sheet, but not the original video bytes.

## Audio references

Prompt models do not receive audio bytes. Audio remains a typed `<Audio N>` reference in the request manifest. State its intended role in the brief:

```text
Use <Audio 1> as the full soundtrack.
Use only the rhythm of <Audio 2>; do not copy its voice.
```

Include any transcript, voice description, music style, rhythm, or sound detail that the prompt needs.

Uploading audio alone does not require its tag in the generated prompt. During Generate, only an exact canonical mention such as `<Audio 1>` in the Creative Brief makes that audio reference required. Text without a canonical tag has no structural reference meaning to Writer; the prompt model still interprets its natural-language meaning.

## How Reference mode keeps track of media

Every active picture and video is expected to be accounted for with its exact `<Picture N>` or `<Video N>` tag. Uploaded audio tags are allowed only when they exist in the current manifest. Generate requires the audio tags used in the Creative Brief. Refine preserves audio tags already present in the current prompt unless the revision instruction contains that exact tag.

Use **Insert reference** beside **Refine** to add a current subject, picture, video, or audio tag at the caret in the Creative Brief, Generated Prompt, or Refine instruction.

After generation, Writer checks the required format and exact media tags. A valid prompt is returned without being rewritten. If a visual reference tag is missing, Writer can make one correction using the same prepared media. If the correction does not pass the check, Writer keeps the original prompt and shows a warning instead of hiding the problem.

## Refine

Select **Refine** to rewrite the current prompt from a short revision instruction. Refine uses the currently selected provider and model. It keeps the current task context and media manifest, and uses the prompt visible in the editor, including manual edits. A normal Refine request does not attach prepared image or video payloads again. After a successful rewrite, you can restore the previous prompt.

In Reference mode, Writer preserves an existing audio reference when its exact `<Audio N>` tag is absent from the revision instruction. When the instruction contains that tag, the reference is mutable for this revision: the prompt model decides from the instruction's meaning whether to add it, keep it, change its role, or remove it. The audit accepts either presence or absence and a format-repair pass preserves that decision instead of restoring the previous reference inventory. The next Refine pass uses the resulting current prompt as its audio-reference baseline; the original Creative Brief does not independently restore a tag removed by an earlier revision.

Any canonical reference tag used by the Creative Brief or revision instruction must exist in the current media manifest. A revised prompt containing a tag outside that manifest is rejected by the audit.

Reference video and audio clips must be 2 to 15 seconds long. An audio-only Reference manifest is not valid; add at least one image or video. Each uploaded file is limited to 1 GB.

## Thinking

For Direct GGUF and compatible Ollama models, the **Thinking** switch asks the model to use a larger reasoning budget. Auto context plans for the assembled input, reasoning, and final answer rather than silently shrinking Thinking to save VRAM.

Direct disables Thinking when a manual context is smaller than 16K. Gemma offers 8K, 16K, and 24K presets. Supported Qwen models offer 16K, 24K, 32K, and 48K presets. Direct also accepts an exact Custom Context. Writer counts Qwen input tokens before loading the full model. In Direct Advanced settings, Generation budget can stay on Auto or use a preset or Custom token limit. Reasoning effort appears only when the selected GGUF template declares supported values. Ollama shows the switch only when the model reports Thinking support. API providers manage reasoning separately. Gemini exposes **Minimal**, **Low**, **Medium**, and **High** in API Settings.

If a model still cannot complete Thinking, Writer reports the fallback. It does not present a standard-mode retry as though the full Thinking request succeeded.

## Saved settings and drafts

Writer saves stable preferences in the browser used to open ComfyUI:

- mode, duration, and aspect ratio;
- selected provider and available model preference;
- Direct Context, KV, Generation budget, and reasoning effort preferences;
- Ollama host and the selected model tag for each host;
- External URL and optional Model ID;
- API preset, URL, model ID, Gemini Thinking level, and Custom capabilities;
- custom Standard, Reference, Music 3 Caption, and Music 3 Lyrics system-prompt overrides.

It never saves API keys. If a saved model no longer exists, discovery falls back without treating the missing model as a fatal error.

Every H3 mode keeps its own Creative Brief and editable prompt draft across a page reload. Music 3 separately keeps its Music Brief, Lyrics, and edited caption. Uploaded media is session content and is not restored after reload.

Continuum drafts additionally keep their generation target, chunk settings, validated continuity plan, and individual prompts. This structural state is used for chunk-local refinement; it contains no provider secret or API key.

In **Settings > Prompt behavior**, select **Restore default drafts**. The button changes to **Click again to confirm** for five seconds. Select it again to delete every saved mode draft. The current mode immediately returns to its current built-in Creative Brief and prompt; the other modes use their current built-in defaults when opened. This includes Reference. Media, provider settings, custom system prompts, and API credentials are not changed.

## System prompts

H3 prompt behavior is shared by all providers and has two profiles:

- **Standard** for T2VA, I2VA, FL2VA, and L2VA;
- **Reference** for Reference mode.

Editing a profile creates an override of the built-in H3 instruction. It does not replace the separate official MiniMax guide for the selected mode. Resetting an override returns to the current built-in system prompt; there are no separate Standard system prompts for each mode.

Music 3 has a collapsed **System prompt** control in its workspace. It contains separate **Caption** and **Lyrics** profiles. The collapsed row shows **Custom** when either profile has an override. These prompts apply through the selected provider in the same way as the H3 profiles.

## Lifecycle controls

- **Free ComfyUI VRAM** releases workflow models loaded by ComfyUI while preserving cached node results. It is separate from the prompt model.
- **Unload Ollama** releases an idle Ollama model retained by Writer.
- **Unload Direct** releases an idle Direct GGUF model.
- **Cancel** stops the current Writer request.
- **Stop & unload** cancels an active Direct or Ollama request and forces that prompt model to unload at the next safe point.
- **Prompt models · N** groups unload actions when more than one Writer-managed local prompt model remains resident.

**Keep model loaded** applies to Direct and Ollama. It is off by default. External llama.cpp and API providers only use **Cancel** because Writer does not own their server or model lifecycle.

**Auto VRAM** is an optional ComfyUI-only control for Direct GGUF and local Ollama. Before Writer starts, it asks an idle ComfyUI to unload workflow models and waits for the release to be confirmed. Before ComfyUI Queue continues, it stops and unloads the Writer-managed local model and confirms that it is no longer resident. If ComfyUI is busy or either release cannot be confirmed, the new action is stopped instead of letting both workloads compete for VRAM. The control is off by default and is not shown in Standalone.

Provider setup details are in [Choose a provider](PROVIDERS.md). Error-specific steps are in [Troubleshooting](TROUBLESHOOTING.md).
