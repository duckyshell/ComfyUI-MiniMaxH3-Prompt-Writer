import { t } from "./i18n.js";
import { newSequence, newChunk } from "./sequence_state.js";

const MODES = ["T2VA", "I2VA", "FL2VA", "L2VA", "Reference"];
const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
function text(value, max = 8000) {
  if (typeof value !== "string" || value.length > max) throw Error(t("draft.invalid_text"));
  return value;
}
function seconds(value, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw Error(t("draft.invalid_duration"));
  return value;
}

// Portable text only. Never restore session IDs, paths, credentials or asset bindings.
export function normalizeDraft(value) {
  if (value?.format !== "h3-writer-draft" || value.version !== 1) throw Error(t("draft.unsupported_file"));
  const d = value.content;
  if (!d || !RATIOS.includes(d.aspectRatio)) throw Error(t("draft.invalid_settings"));
  let content;
  if (value.kind === "sequence") {
    if (!Array.isArray(d.chunks) || !d.chunks.length || d.chunks.length > 100) throw Error(t("draft.chunk_range"));
    if (!["official", "compact"].includes(d.outputFormat)) throw Error(t("draft.invalid_output_format"));
    content = { ...newSequence(), brief: text(d.brief, Infinity), instructions: text(d.instructions, 32000),
      aspectRatio: d.aspectRatio, defaultDuration: seconds(d.defaultDuration, 15), outputFormat: d.outputFormat,
      chunks: d.chunks.map(c => ({ ...newChunk(seconds(c.duration, 15)), instruction: text(c.instruction), prompt: text(c.prompt, 100000),
        ...(c.attention ? {attention:text(c.attention)} : {}) })),
      copyFormat: { format: d.copyFormat?.format === "custom" ? "custom" : "prompts",
        template: text(d.copyFormat?.template ?? "{prompt}"), separator: text(d.copyFormat?.separator ?? "\n\n", 2000) } };
  } else if (value.kind === "single" && MODES.includes(d.mode)) {
    content = { mode:d.mode, aspectRatio:d.aspectRatio, duration:seconds(d.duration,20),
      brief:text(d.brief, Infinity), prompt:text(d.prompt,100000), instructions:d.instructions === null ? null : text(d.instructions, 32000) };
  } else throw Error(t("draft.unsupported_type"));
  const media = Array.isArray(value.media) ? value.media.slice(0,100).map(n => text(n,2000)) : [];
  return { format:"h3-writer-draft", version:1, kind:value.kind, content, media };
}

export function parseDraft(source) {
  if (source.length > 2_000_000) throw Error(t("draft.too_large"));
  let value;
  try { value = JSON.parse(source); } catch { throw Error(t("draft.invalid_json")); }
  return normalizeDraft(value);
}

export function draftFile(kind, content, media = []) {
  const value = normalizeDraft({format:"h3-writer-draft", version:1, kind, content, media});
  if (new Blob([JSON.stringify(value,null,2)]).size > 2_000_000) throw Error(t("draft.too_large"));
  return value;
}

export function draftFilename(kind, now = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join("-");
  return `h3-${kind === "sequence" ? "sequence" : "single"}-${date}_${time}.json`;
}
