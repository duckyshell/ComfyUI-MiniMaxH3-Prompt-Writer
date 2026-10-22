import { messageText, t } from "./i18n.js";

const ASPECT_LABEL_KEYS = {
  "1:1": "aspect.square", "2:3": "aspect.portrait", "3:2": "aspect.landscape",
  "3:4": "aspect.portrait", "4:3": "aspect.landscape", "9:16": "aspect.vertical",
  "16:9": "aspect.widescreen", "21:9": "aspect.ultrawide",
};

export const ASPECT_RATIOS = [
  ["1:1", "Square"], ["2:3", "Portrait"], ["3:2", "Landscape"], ["3:4", "Portrait"],
  ["4:3", "Landscape"], ["9:16", "Vertical"], ["16:9", "Widescreen"], ["21:9", "Ultrawide"],
];

export function generationButtonMarkup(icon, busy, label) {
  return busy
    ? `<span class="h3ps-spinner"></span><span data-generate-label data-i18n="generation.cancel">${t("generation.cancel")}</span>`
    : `${icon("spark", 16)}<span data-generate-label>${messageText(label)}</span>`;
}

export function sequenceNotificationOptions(error) {
  return error.severity === "warning" ? {durationMs:8000} : {dismissOnWorkspaceClick:true};
}

export function aspectRatioMarkup(icon, key = "aspect") {
  return `<label class="h3ps-field h3ps-choice"><span data-i18n="aspect.label">Aspect ratio</span><button type="button" aria-expanded="false" data-choice-toggle="${key}"><b data-aspect-label>16:9</b><em data-aspect-description data-i18n="aspect.widescreen">${t("aspect.widescreen")}</em>${icon("chevron", 13)}</button><div class="h3ps-choice-menu h3ps-aspect-menu" role="group" aria-label="${t("aspect.label")}" data-i18n-aria-label="aspect.label" data-choice-menu="${key}" hidden>${ASPECT_RATIOS.map(([value]) => `<button type="button" aria-pressed="false" data-aspect="${value}"><b>${value}</b><em data-i18n="${ASPECT_LABEL_KEYS[value]}">${t(ASPECT_LABEL_KEYS[value])}</em></button>`).join("")}</div></label>`;
}

export function bindAspectRatio(field, value, onChange) {
  const toggle = field.querySelector("[data-choice-toggle]"), menu = field.querySelector("[data-choice-menu]");
  const close = () => { menu.hidden = true; toggle.setAttribute("aria-expanded", "false"); };
  const update = value => {
    const option = ASPECT_RATIOS.find(([v]) => v === value) || ASPECT_RATIOS[6];
    field.querySelector("[data-aspect-label]").textContent = option[0];
    const description = field.querySelector("[data-aspect-description]");
    description.dataset.i18n = ASPECT_LABEL_KEYS[option[0]];
    description.textContent = t(ASPECT_LABEL_KEYS[option[0]]);
    field.querySelectorAll("[data-aspect]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.aspect === option[0])));
  };
  toggle.addEventListener("click", event => {
    event.preventDefault();
    const open = menu.hidden;
    field.closest(".h3ps-root")?.querySelectorAll("[data-choice-menu]").forEach(m => { m.hidden = true; });
    field.closest(".h3ps-root")?.querySelectorAll("[data-choice-toggle]").forEach(b => b.setAttribute("aria-expanded", "false"));
    menu.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
  });
  field.querySelectorAll("[data-aspect]").forEach(b => b.addEventListener("click", event => { event.preventDefault(); update(b.dataset.aspect); close(); onChange(b.dataset.aspect); }));
  update(value);
  return { close, update };
}

// Attribute strings and contents are trusted markup from the owning workspace.
export function splitMenuMarkup(icon, {label, primary, toggle, menu, contents, ariaLabel, ariaLabelKey}) {
  const aria = ariaLabelKey
    ? `aria-label="${t(ariaLabelKey)}" data-i18n-aria-label="${ariaLabelKey}"`
    : `aria-label="${ariaLabel}"`;
  return `<button class="h3ps-clear-primary" type="button" ${primary} aria-expanded="false">${label}</button>
    <button class="h3ps-clear-toggle" type="button" ${aria} aria-expanded="false" ${toggle}>${icon("chevron", 12)}</button>
    <div class="h3ps-clear-menu" ${menu} hidden>${contents}</div>`;
}
export function setSplitMenuOpen(control, open) {
  if (!control) return;
  control.querySelector(".h3ps-clear-menu").hidden = !open;
  control.querySelectorAll(":scope > button").forEach(b => b.setAttribute("aria-expanded", String(open)));
}
export function copyButtonMarkup(icon, attributes, label = "", iconOnly = false) {
  return `<button class="${iconOnly ? "h3ps-icon-button" : "h3ps-secondary-button"}" type="button" ${attributes}>${icon("copy", 15)}${label ? ` ${label}` : ""}</button>`;
}

// Option labels and actions are trusted constants supplied by Writer views.
export function formatChoiceMarkup(label, options, selected, labelKey = "") {
  const aria = labelKey
    ? `aria-label="${t(labelKey)}" data-i18n-aria-label="${labelKey}"`
    : `aria-label="${label}"`;
  return `<div class="h3ps-sequence-copy-choice" role="group" ${aria}>${options.map(([action,text])=>`<button type="button" data-seq-action="${action}" aria-pressed="${action===selected}">${text}</button>`).join("")}</div>`;
}

export function fitTextarea(editor, minimumHeight, borderHeight = 0) {
  // Measuring a collapsed textarea can clamp the surrounding panel's scroll offset.
  const scroll = [];
  for (let parent = editor.parentElement; parent; parent = parent.parentElement) {
    scroll.push([parent, parent.scrollTop]);
  }
  editor.style.height = "auto";
  editor.style.height = `${Math.max(minimumHeight, editor.scrollHeight + borderHeight)}px`;
  for (const [parent, top] of scroll) parent.scrollTop = top;
}
