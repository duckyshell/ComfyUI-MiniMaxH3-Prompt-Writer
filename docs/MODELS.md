# Model setup

H3 Prompt Writer uses multimodal Gemma 4 GGUF models through `llama-cpp-python`.
Each model listed below must use the projector linked in the same row.

Open both verified Hugging Face file pages in the selected row, download the files,
and place them together in `ComfyUI/models/LLM/`. H3 Prompt Writer never starts a model
download automatically.

For multiple models, keep each model and its matching vision projector together
in a separate subfolder. H3 Prompt Writer does not guess between multiple models or
projectors in the same directory.

| VRAM | Model GGUF | Matching projector | Context |
| --- | --- | --- | --- |
| 8 GB | [Gemma 4 E4B Q3_K_M](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/blob/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q3_K_M.gguf) | [E4B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/blob/bfc15c382204943c3a8fff0c750b94ae2364d7a3/mmproj-BF16.gguf) | 8K |
| 12 GB | [Gemma 4 12B Q4_K_S](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q4_K_S.gguf) | [12B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/mmproj-BF16.gguf) | 8K |
| 16 GB | [Gemma 4 12B Q5_K_M](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q5_K_M.gguf) | [12B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/fc034cfff751157913579611efad8462ac1be606/mmproj-BF16.gguf) | 16K |
| 24 GB | [Gemma 4 26B-A4B Q4_K_M](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/blob/c099eb48e663fd284577b04978a94ffccb261841/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf) | [26B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/blob/c099eb48e663fd284577b04978a94ffccb261841/mmproj-BF16.gguf) | 16K |
| 32 GB | [Gemma 4 31B Q4_K_XL](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/blob/c1ac76e99d5513b141e8adde7288b85c3f9c32ec/gemma-4-31B-it-UD-Q4_K_XL.gguf) | [31B mmproj-BF16](https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/blob/c1ac76e99d5513b141e8adde7288b85c3f9c32ec/mmproj-BF16.gguf) | 16K |

## Which model should I choose?

- **8 GB:** E4B is the compatibility option. It is useful for simpler briefs but
  loses visual detail sooner in mixed-reference tasks.
- **12 GB:** 12B Q4 is the compact default. Prefer 8K unless preflight requires 16K.
- **16 GB:** 12B Q5 is the full 12B-quality tier with normal 16K operation.
- **24 GB:** 26B-A4B is the best overall balance observed in local QA.
- **32 GB:** 31B can extract more visual detail, but it is slower and was not
  consistently better at producing a final H3-ready prompt.

VRAM figures include the model, projector, context, and local QA request overhead,
but remain starting points rather than guarantees. Free other GPU-heavy models and
applications when available memory is close to the tier boundary.

## Runtime defaults

- **Context:** Auto selects the smallest 8K or 16K context that fits the assembled
  request. It never selects 24K.
- **KV cache:** Auto/Q8 is the tested default. F16 is available manually.
- **Thinking:** Off by default. Manual 8K disables it.
- **24K:** Manual only, for requests that cannot fit 16K and have sufficient VRAM.

Q4 KV is intentionally not exposed: in the tested runtime it saved little memory
and reduced decode speed substantially.

## Other models

v0.2.0 has been tested only with the model and projector pairs listed above.
Other Gemma 4 GGUF files may appear in H3 Prompt Writer, but their compatibility has not
been validated. Each directory must still contain exactly one model GGUF and one
projector.
