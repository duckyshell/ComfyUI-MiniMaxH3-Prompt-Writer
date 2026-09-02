# Changelog

## Unreleased

### Features

- Added H3 Continuum as a separate video output target with native 1–16 chunk and 4–30 second controls (5–15 seconds recommended).
- Added validated continuity planning followed by sequential chunk-local H3 prompt generation and canonical Continuum Timeline serialization with one shared sequence-wide H3 preamble.
- Added deterministic integer and fractional Timeline boundaries and strict Writer-side validation instead of relying on Continuum's Fixed fallback.
- Added chunk-local refinement that preserves the shared preamble and every unchanged chunk body byte-for-byte, with hashes computed from the exact resolved prompts Continuum receives.
- Added an explicit graph handoff for H3 Continuum Sampler V3.4–V3.7 with unambiguous sampler selection, **Prompt Format = Timeline** compatibility, settings mismatch review, connected Text (Multiline) updates, and clipboard fallback.
- Added downstream H3 Continuum conditioning discovery with exact public identity rules: Reference Images own compact `<Picture N>` numbering in hybrid runs; keyframe-only First/Last inputs own temporal Picture identities; Video Reference is persistent `<Video 1>`; V3.5+ Reference Audio is persistent `<Audio 1>`; Driving Audio remains untagged.

### Reliability

- Aligned Continuum compatibility with current upstream V3.4–V3.7 samplers, including the V3.5+ Reference Audio `<Audio 1>` contract and native 4–30-second chunk range while retaining 5–15 seconds as the recommended range.

- Hardened H3 Continuum sequence-plan recovery after schema drift: the one bounded repair pass now retains the complete original planner contract instead of replacing it with a weaker repair-only system prompt, explicitly rechecks non-empty shared preamble and numeric stable-subject IDs, and canonicalizes reserved model aliases such as `<Subject A>` → `<Subject 1>` consistently across the plan before validation.
- Added bounded deterministic planner-contract recovery before/after the single LLM repair: one identifiable plan JSON object may be extracted from harmless wrapper prose; optional internal text fields may default to their allowed empty form; application-owned indexes/assignments are removed; and an empty shared preamble is replaced with one synthesized only from existing global subject/continuity/constraint semantics plus authoritative persistent reference identities, with a content-neutral continuity fallback. Missing chunk semantics, wrong chunk count, subject/reference drift, and scope violations remain strict errors.
- Added exact pre-execution materialization for stable workflow references passed through the reviewed `ImageScaleToTotalPixelsX` / **Scale Image to Total Pixels Adv** node (contract pinned to `79e831097bb7a76ade3a28359300e62332086c42`). Static megapixel/multiple and stretch/crop/pad chains using Lanczos now import the transformed H3 reference instead of being rejected as a generic processed image chain.
- Transform settings are included in downstream source identity, so changing scaler parameters produces **Update needed**. Any connected runtime override for width, height, megapixels, multiple-of, resize mode, or interpolation fails closed rather than using a stale widget value; non-Lanczos methods, animated sources, unsupported upstreams, and arbitrary processing chains remain unavailable.
- After materialization, the Active workflow images row previews the actual post-transform Prompt Writer asset seen by the prompt model rather than the upstream source thumbnail.
- Added a dedicated backend materialization endpoint, exact Lanczos/crop geometry regression tests, route coverage, frontend chain tests, and a pinned cross-repository scaler contract CI lane.
- Added the missing **Active workflow images** UI for Reference + H3 Continuum, including **Add active workflow refs**, per-slot Add/Update state, ComfyUI image materialization for stable Image Conveyor Reference Shelf and direct Load Image sources, and exact downstream `model_asset_id` binding so the prompt model can inspect the same references that will condition H3.
- Dynamic queue-group/queue-driven sources and processed image chains remain visible as active workflow conditioning but are deliberately not imported as fake stable media when their exact execution pixels are not available yet.
- Apply-to-Continuum now compares downstream workflow source identity separately from Prompt Writer media visibility/binding, so a correctly bound model-visible copy does not look like graph source drift.
- Re-materializing the same stable workflow reference after a Prompt Writer session reload may use a new temporary media asset ID without falsely triggering source drift only when the saved stable workflow fingerprint still matches; unfingerprinted bindings stay strict. Model visibility remains part of the contract. Manually replacing an imported copy drops its workflow binding so unrelated pixels cannot continue masquerading as that downstream Picture.
- Added first-class Image Conveyor compatibility for Continuum conditioning discovery, honoring persistent Reference Shelf population/output switches, Main/Last Frame switches, Queue execution-group size, the legacy node alias, and single-image transform/bypass chains instead of trusting visible wires alone.
- Added opaque saved source fingerprints for persistent Image Conveyor Reference Shelf images so shelf replacements trigger Continuum source-drift protection without storing filenames; queue-group members remain intentionally dynamic. Legacy saved inventories without fingerprints are accepted once against otherwise identical topology and upgraded to the active fingerprint on successful refinement.
- Added a pinned Image Conveyor 1.7.2 cross-repository CI contract alongside Prompt Writer's frontend coverage.
- Relaxed Continuum's internal `continuity_anchors` and `persistent_constraints` to allow intentionally empty text while still requiring the fields and their types; they no longer abort otherwise valid plans with no extra sequence-wide metadata.
- Changed the single bounded Continuum planner repair to audit and repair the complete schema contract rather than fixing only the first validation failure and exposing the next one.
- Added deterministic structural sequence persistence without storing provider secrets.
- Separated model-visible Prompt Writer media from downstream H3 conditioning identities. Workflow-only references can be declared without sending their pixels to the prompt model, and uploaded analysis media cannot silently impersonate a downstream `<Picture N>`.
- Added explicit model-asset binding validation for future verified media reuse, rejecting missing, wrong-type, and duplicate bindings.
- Added cross-repository CI that checks Writer Timeline output against the current H3 Continuum `v2/prompts.py` parser and verifies exact resolved prompts and SHA-256 hashes.
- Added sequence progress, cancellation, exact chunk-failure reporting, bounded one-shot plan repair, chunk-scoped reference validation with a narrow Continuum-only correction pass, final-stage unload behavior, and cumulative provider accounting.
- Added temporal-mode validation against the selected H3 Continuum First/Last Frame wiring and blocked generation, refinement, or handoff when the selected mode does not match the active keyframe topology.
- Added saved downstream-conditioning snapshots so later refinement and graph handoff reject observable source rewiring that would silently reuse the same public reference tags for different workflow inputs.
- Added native Continuum chunk-body validation for repeated shared preambles, standalone H3 field/shot wrappers, nested Timeline headers, keyframe-alignment boilerplate, and undeclared subject identities.
- Made **Sync settings & apply** transactional: Writer now resolves the editable Sequence Prompt target before mutation and restores sampler/text widget values if a graph callback fails.
- Fixed Continuum draft persistence after the schema-v2 contract rework: saved sequences now retain their shared preamble and downstream-conditioning snapshot, while legacy schema-v1 drafts migrate to v2 on save/load.
- Restricted legacy `[Chunk N]` migration to genuinely legacy saved sequences so schema-v2 Timeline drafts cannot silently discard their shared preamble.

### Fixes

- Extended LM Studio metadata and capability discovery to Custom endpoints on private LAN addresses, matching the existing Custom-provider HTTP security policy.

## 0.4.4 - 2026-09-02

### Features

- Added optional **Auto VRAM** coordination between ComfyUI workflows and Writer-managed Direct GGUF or local Ollama models.
- Added a compact Clear menu for clearing prompts while keeping media, or clearing the entire workspace.
- Added custom 2–16 frame contact sheets with more readable frame labels.

### Fixes

- Allowed private-network Ollama hostnames while pinning the validated address, and preserved unsaved host edits during background refreshes.
- Pinned the tested Windows CUDA 13 install and recovery guidance to `llama-cpp-python 0.3.35`.
- Skipped unnecessary ComfyUI VRAM release polling when no workflow models are loaded.

## 0.4.3 - 2026-08-29

### Features

- Added custom Context, Generation budget, and template-supported reasoning effort controls for Direct GGUF.
- Increased the video Creative Brief limit from 2,000 to 8,000 characters.

### Fixes

- Classified installed GGUF models and projectors from metadata so renamed projector files remain discoverable.
- Kept External llama.cpp reasoning settings under server control while separating returned reasoning from the final prompt.
- Refined Reference media sizing and compact replace and remove controls.
- Prevented media controls from staying visible after a cancelled file selection.

## 0.4.2 - 2026-08-28

### Packaging

- Added the separate Standalone Windows release channel while keeping it out of the Comfy Registry package.
- Added reproducible release ZIP builds and clearer installation links for both products.
- Clarified which provider and troubleshooting instructions apply to ComfyUI and Standalone.

## 0.4.1 - 2026-08-24

### Fixes

- Improved Direct GGUF tokenizer startup and runtime compatibility in Windows Portable installations.

## 0.4.0 - 2026-08-24

### Features

- Added Qwen 3.8 support for Direct GGUF with vision references and optional Thinking.
- Added support for compatible Qwen 3.8 fine-tunes and Qwen3-VL models. Untested combinations are marked as compatible but unverified.
- Added text-only fallback when a Direct model has no compatible vision projector.
- Added automatic 16K, 24K, 32K, and 48K context selection for supported Qwen models.

### Interface

- Added in-place replacement for Reference media. Use the asset menu or drop one file on a card. Dropping several files still adds them to the end of the list.

### Fixes

- Improved tokenizer reliability for multilingual briefs, unusual Unicode input, startup failures, and Windows Portable installs.
- Rejected Direct models whose declared context is smaller than the available context choices.
- Limited the verified label to the exact model and projector combinations that were tested.
- Waited for enough ComfyUI VRAM to become free before retrying generation.
- Kept media duration labels visible above landscape thumbnails.

## 0.3.6 - 2026-08-22

### Fixes

- Made generation and refinement admission atomic and cancellation reliable, including deferred unload handling.
- Moved media processing off the ComfyUI event loop and added predictable cleanup for expired media sessions and generation state.
- Hardened Direct GGUF resource cleanup and improved model lookup with safe cache invalidation.
- Added clear fallback errors for non-JSON HTTP responses.
- Added CI for the Python and frontend test suites.

## 0.3.5 - 2026-08-21

### Fixes

- Cleaned up Direct GGUF console logging to prevent prompt contents and verbose MTMD output from being printed while preserving useful warnings, errors, and generation metrics.

## 0.3.4 - 2026-08-21

### Fixes

- Increased the non-Thinking H3 output ceiling from 1,536 to 2,048 tokens to reduce prompt truncation on longer generations and refinements.
- Prevented Direct GGUF cleanup from failing when the vision handler had already closed its exit stack.

## 0.3.3 - 2026-08-21

### Interface

- Added fullscreen Writer mode with a persistent toggle and improved large-screen layout.
- Improved Refine controls with a vertically resizable instruction editor and clearer Refine and Cancel actions.

### Fixes

- Refine now uses the current edited prompt as the source for each revision and keeps media as manifest-only context instead of re-uploading it.
- Stabilized Reference audio handling so untouched audio references are preserved while explicitly targeted references can change.
- Fixed the Free ComfyUI VRAM action returning to its normal state after a request.
- Added compatibility with newer `llama-cpp-python` GGML type exports.
- Improved Custom OpenAI-compatible connection errors, including non-JSON HTTP failures and missing model-list handling.
- Fixed long Creative Brief sizing when reopening the Writer and when using fullscreen.
- Scoped prompt-model visual reads to media owned by the current Writer session.
- Made Direct GGUF and Ollama startup detection less invasive while preserving the tested Windows Portable CUDA 13 install guidance.

## 0.3.2 - 2026-08-14

### Features

- Added an optional Music 3 workspace for writing structured captions for the separate MiniMax Music 3 model.
- Added saved Music Brief, optional Lyrics, editable generated captions, and separate Caption and Lyrics system prompts.
- Added one Lyrics Refine flow for creating new Lyrics or rewriting the current text, with optional Music Brief context and one-step restore.
- Added a Reference mode control for inserting current reference tags at the caret in the Creative Brief, Generated Prompt, or Refine instruction.

### Fixes

- Allowed Custom OpenAI-compatible endpoints to use plain HTTP on loopback and private LAN addresses while keeping HTTPS required for public endpoints.
- Allowed External llama.cpp to use text-only models for requests without images or video. Visual requests now show a clear vision requirement.

## 0.3.1 - 2026-08-13

### Fixes

- Prevented media changes and mode switching during generation or refinement.
- Made media replacement and video resampling transactional so failed operations preserve the existing asset.
- Limited Clear to media in the current mode and ensured generation and refinement use the latest media after uploads, removals, resampling, and reordering.
- Fixed Reference Audio handling: uploaded audio remains optional, Generate honors exact `<Audio N>` tags in the Creative Brief, and Refine preserves untouched audio references while allowing explicitly tagged references to change.
- Rejected nonexistent canonical reference tags before loading or invoking the selected model.
- Improved Direct GGUF compatibility diagnostics.

## 0.3.0 - 2026-08-12

### New interface

- Redesigned the Writer and Settings interface.
- Added clear setup pages for Ollama, Direct GGUF, External llama.cpp, and API
  providers.
- Separated provider settings from shared prompt behavior.
- Added clearer model status, setup guidance, capability labels, and unload
  controls.

### New providers

- Added Ollama as the recommended local setup.
- Added automatic Ollama detection, installed-model discovery, tested Gemma 4
  recommendations, copyable pull commands, and request-aware context selection.
- Added optional API providers for Gemini, OpenAI, OpenRouter, and Custom
  OpenAI-compatible endpoints.
- Added Gemini Thinking levels and session-only API key handling.
- Added support for local OpenAI-compatible endpoints such as LM Studio.
- Gave the existing External llama.cpp integration its own dedicated provider
  setup.
- Validated Qwen 3.6 through Ollama in all five H3 modes without model-specific
  changes to Writer.

### Drafts and prompt behavior

- Added a separate saved Creative Brief and editable prompt draft for every mode,
  including Reference.
- Added saved provider preferences without storing API keys or active session
  state.
- Added shared Standard and Reference system-prompt profiles.
- Added a two-click option to restore all saved drafts to the current built-in
  defaults.
- Added mode-specific example drafts for T2VA, I2VA, FL2VA, L2VA, and Reference.

### Context and Thinking

- Added automatic context planning for the complete request, including prepared
  media, reasoning, and final output.
- Added request-aware Ollama context selection within the model's reported limit.
- Improved Thinking budgeting so larger Reference requests do not lose the
  requested reasoning budget to an undersized context.
- Kept provider-specific reasoning controls separate from the general local
  Thinking switch.

### Reference generation

- Added stricter checks for active `<Picture N>`, `<Video N>`, and `<Audio N>`
  references.
- Added one bounded multimodal correction when a visual reference is missing from
  the first prompt.
- Kept the original prompt and showed a persistent warning when a correction could
  not pass validation.
- Improved handling of motion-only references so unrelated identity, clothing,
  setting, lighting, and audio details are less likely to transfer.

### Model and VRAM controls

- Added separate controls for cancelling a request, unloading a Direct model,
  unloading an Ollama model, and freeing ComfyUI workflow VRAM.
- Added **Stop & unload** for active Direct and Ollama requests.
- Improved Ollama ownership tracking so Writer does not offer to unload models
  started by another application.
- Kept External llama.cpp and API model lifecycle under server or provider control.

### Fixes

- Fixed delayed first-stream responses from External llama.cpp being treated as a
  failed request.
- Fixed important generation warnings disappearing before they could be read.
- Fixed large Thinking requests falling back because the automatic context was too
  small.
- Fixed missing active visual references being repaired without access to the
  original media.
- Fixed provider discovery changing the open Settings provider page.
- Fixed unload controls disappearing after switching to another provider.
- Improved Direct GGUF guidance when the optional native runtime is missing or
  incompatible.

### Documentation

- Rewrote the installation, provider, usage, privacy, and troubleshooting guides
  for v0.3.
- Added practical Creative Brief and reference-role examples.
- Added new screenshots for the redesigned interface.

## 0.2.1 - 2026-08-11

- Added a browser-compatible UUID fallback for ComfyUI opened through non-secure
  LAN HTTP origins.
- Fixed repeated media drop listeners that could upload the same file more than
  once after UI rerenders.
- Made dropping one media card onto another reorder it in either direction
  without requiring the pointer to cross the target card's outer edge.
- Changed Auto video sampling to 6 frames, added explicit 4/6/8 options, and
  cache-busted regenerated previews, contact sheets, and frames so every
  selection displays the new sheet.
- Added exact model scan paths, discovered GGUF/mmproj files, and pairing issues
  to local model setup details without changing discovery rules.
- Added a lazy, cached, subprocess-isolated `llama-cpp-python` compatibility
  check before Direct GGUF generation and refinement.
- Added actionable details for native probe crashes, invalid CUDA/HIP runtime
  paths, and unavailable GPU offload without assuming a specific backend.

## 0.2.0 - 2026-08-10

- Added optional support for an existing local OpenAI-compatible `llama.cpp`
  server with a loaded Gemma 4 model and matching vision projector.
- Added connection, health, vision-capability, cancellation, and external model
  lifecycle handling while leaving model and runtime configuration to the server.

## 0.1.0 - 2026-08-09

- First public release of the ComfyUI UI extension.
- T2VA, I2VA, FL2VA, L2VA, and Reference prompt generation.
- Local multimodal Gemma 4 GGUF support with matching projector validation.
- Ordered video contact sheets, editable prompts, Refine, Cancel, and contextual
  ComfyUI/prompt-model VRAM release.
- Automatic context preflight and compact advanced runtime controls.
- Measured free-VRAM preflight with native ComfyUI unload-and-retry handling.
- Released as version 0.1.0 under the MIT License.
