// Asset IDs own identity; visible Reference labels follow the current media order.
// Replace in one pass so swaps cannot cascade and removed tags cannot be reused.
export function referenceTextRemapper(previous, next, mode = "Reference") {
  const current = new Map(next.filter(a => a.mode === mode).map(a => [a.id, a]));
  const labels = new Map();
  for (const asset of previous) {
    if (asset.mode !== mode || !asset.reference) continue;
    const replacement = current.get(asset.id);
    const tag = replacement?.type === asset.type ? replacement.reference : null;
    if (tag !== asset.reference) labels.set(asset.reference, tag || asset.reference.replace("<", "<Missing "));
  }
  return text => typeof text === "string"
    ? text.replace(/<(Picture|Video|Audio) ([1-9]\d*)>/g, tag => labels.get(tag) || tag)
    : text;
}
