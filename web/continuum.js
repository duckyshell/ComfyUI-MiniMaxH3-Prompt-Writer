export const CONTINUUM_SCHEMA_VERSION = 2;
export const LEGACY_CONTINUUM_SCHEMA_VERSION = 1;
export const CONTINUUM_MIN_CHUNKS = 1;
export const CONTINUUM_MAX_CHUNKS = 16;
export const CONTINUUM_MIN_SECONDS = 4;
export const CONTINUUM_MAX_SECONDS = 30;
export const CONTINUUM_SAMPLER_NODE_IDS = new Set([
  "H3ContinuumSamplerV34",
  "H3ContinuumSamplerV35",
  "H3ContinuumSamplerV36",
  "H3ContinuumSamplerV37",
]);
export const CONTINUUM_PROMPT_MODE = "Timeline";

const LEGACY_CHUNK_HEADER = /^\s*\[\s*Chunk\s+(\d+)\s*\]\s*$/i;
const TIMELINE_HEADER = /^\s*\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*$/i;
const EDITABLE_MULTILINE_NODE_IDS = new Set(["PrimitiveStringMultiline"]);
const CONTINUUM_REFERENCE_INPUTS = Array.from({ length: 8 }, (_, offset) => `reference_image_${offset + 1}`);
const CONDITIONING_ROLES = new Map([
  ["first_frame", { role: "first_frame", kind: "image" }],
  ["last_frame", { role: "last_frame", kind: "image" }],
  ["reference_video_1", { role: "video_reference", kind: "video" }],
  ["reference_audio_1", { role: "reference_audio", kind: "audio" }],
  ["driving_audio", { role: "driving_audio", kind: "audio" }],
]);

export function normalizeContinuumSettings(value = {}) {
  const chunks = Number(value.chunks);
  const chunkSeconds = Number(value.chunk_seconds ?? value.chunkSeconds);
  if (!Number.isInteger(chunks) || chunks < CONTINUUM_MIN_CHUNKS || chunks > CONTINUUM_MAX_CHUNKS) {
    throw new Error(`Continuum chunks must be between ${CONTINUUM_MIN_CHUNKS} and ${CONTINUUM_MAX_CHUNKS}.`);
  }
  if (!Number.isFinite(chunkSeconds) || chunkSeconds < CONTINUUM_MIN_SECONDS || chunkSeconds > CONTINUUM_MAX_SECONDS) {
    throw new Error(`Continuum chunk duration must be between ${CONTINUUM_MIN_SECONDS} and ${CONTINUUM_MAX_SECONDS} seconds.`);
  }
  return {
    schema_version: CONTINUUM_SCHEMA_VERSION,
    chunks,
    chunk_seconds: chunkSeconds,
    total_seconds: Number((chunks * chunkSeconds).toFixed(12)),
  };
}

function decimalParts(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Continuum timeline value must be finite and non-negative.");
  let text = String(number);
  if (/e/i.test(text)) {
    text = number.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("Continuum timeline value cannot be represented canonically.");
  const [whole, fraction = ""] = text.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const units = BigInt(whole + fraction);
  return { units, scale, digits: fraction.length };
}

function formatScaledUnits(units, scale, digits) {
  if (digits === 0) return String(units);
  const whole = units / scale;
  const fractionUnits = units % scale;
  let fraction = fractionUnits.toString().padStart(digits, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function timelineBoundary(chunkSeconds, index) {
  if (!Number.isInteger(index) || index < 0) throw new Error("Continuum timeline boundary index must be non-negative.");
  const { units, scale, digits } = decimalParts(chunkSeconds);
  if (units <= 0n) throw new Error("Continuum chunk duration must be positive.");
  return formatScaledUnits(units * BigInt(index), scale, digits);
}

function containsReservedHeader(value) {
  return String(value).split(/\r?\n/).some((line) => LEGACY_CHUNK_HEADER.test(line) || TIMELINE_HEADER.test(line));
}

function normalizePrompts(prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) throw new Error("A Continuum sequence needs at least one chunk.");
  return prompts.map((prompt, offset) => {
    const value = typeof prompt === "string" ? prompt.trim() : "";
    if (!value) throw new Error(`Chunk ${offset + 1} prompt is empty.`);
    if (containsReservedHeader(value)) throw new Error(`Chunk ${offset + 1} contains a reserved Continuum section header.`);
    return value;
  });
}

export function serializeContinuumPrompts(prompts, { preamble = "", chunkSeconds = 5 } = {}) {
  const bodies = normalizePrompts(prompts);
  const shared = typeof preamble === "string" ? preamble.trim() : "";
  if (shared && containsReservedHeader(shared)) throw new Error("Continuum shared preamble contains a reserved section header.");
  const sections = bodies.map((body, offset) => (
    `[${timelineBoundary(chunkSeconds, offset)}-${timelineBoundary(chunkSeconds, offset + 1)}s]\n${body}`
  ));
  return shared ? `${shared}\n\n${sections.join("\n\n")}` : sections.join("\n\n");
}

export function parseContinuumTimeline(script, { expectedChunks, chunkSeconds } = {}) {
  if (typeof script !== "string" || !script.trim()) throw new Error("Continuum sequence text is empty.");
  const chunks = Number(expectedChunks);
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error("Expected Continuum chunk count is required.");
  const seconds = Number(chunkSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Expected Continuum chunk duration is required.");

  const preambleLines = [];
  const prompts = [];
  let body = [];
  let currentIndex = null;

  const finish = () => {
    if (currentIndex == null) return;
    const prompt = body.join("\n").trim();
    if (!prompt) throw new Error(`Timeline section ${currentIndex + 1} prompt is empty.`);
    prompts.push(prompt);
    body = [];
  };

  script.split(/\r?\n/).forEach((line, offset) => {
    const match = line.match(TIMELINE_HEADER);
    if (match) {
      finish();
      const nextIndex = currentIndex == null ? 0 : currentIndex + 1;
      if (nextIndex >= chunks) throw new Error(`Line ${offset + 1}: too many Timeline sections.`);
      const expectedHeader = `[${timelineBoundary(seconds, nextIndex)}-${timelineBoundary(seconds, nextIndex + 1)}s]`;
      const actualStart = Number(match[1]);
      const actualEnd = Number(match[2]);
      const expectedStart = Number(timelineBoundary(seconds, nextIndex));
      const expectedEnd = Number(timelineBoundary(seconds, nextIndex + 1));
      if (actualStart !== expectedStart || actualEnd !== expectedEnd || line.trim() !== expectedHeader) {
        throw new Error(`Line ${offset + 1}: expected ${expectedHeader}, found ${line.trim()}.`);
      }
      currentIndex = nextIndex;
      return;
    }
    if (currentIndex == null) {
      if (LEGACY_CHUNK_HEADER.test(line)) throw new Error("Legacy [Chunk N] syntax is not canonical Continuum Timeline syntax.");
      preambleLines.push(line);
      return;
    }
    if (LEGACY_CHUNK_HEADER.test(line)) throw new Error("Legacy [Chunk N] syntax cannot appear inside a Timeline sequence.");
    body.push(line);
  });
  finish();

  if (currentIndex == null) throw new Error("No canonical [start-end] Timeline sections were found.");
  if (prompts.length !== chunks) throw new Error(`Expected ${chunks} Timeline sections, found ${prompts.length}.`);
  const preamble = preambleLines.join("\n").trim();
  const canonical = serializeContinuumPrompts(prompts, { preamble, chunkSeconds: seconds });
  if (canonical !== script.trim()) throw new Error("Continuum Timeline contains non-canonical whitespace or header formatting.");
  return { preamble, prompts };
}

export function parseContinuumPrompts(script, expectedChunks = null, chunkSeconds = 5) {
  if (expectedChunks == null) throw new Error("Expected Continuum chunk count is required.");
  return parseContinuumTimeline(script, { expectedChunks, chunkSeconds }).prompts;
}

function parseLegacyChunkPrompts(script, expectedChunks = null) {
  if (typeof script !== "string" || !script.trim()) throw new Error("Legacy Continuum sequence text is empty.");
  const prompts = [];
  let currentIndex = null;
  let body = [];
  const finish = () => {
    if (currentIndex == null) {
      if (body.some((line) => line.trim())) throw new Error("Legacy migration rejects text before [Chunk 1].");
      body = [];
      return;
    }
    const prompt = body.join("\n").trim();
    if (!prompt) throw new Error(`Legacy Chunk ${currentIndex} prompt is empty.`);
    prompts.push(prompt);
    body = [];
  };
  script.split(/\r?\n/).forEach((line, offset) => {
    if (TIMELINE_HEADER.test(line)) throw new Error("Legacy migration cannot mix Timeline and [Chunk N] sections.");
    const match = line.match(LEGACY_CHUNK_HEADER);
    if (!match) {
      body.push(line);
      return;
    }
    finish();
    const index = Number(match[1]);
    const expected = prompts.length + 1;
    if (index !== expected) throw new Error(`Line ${offset + 1}: expected [Chunk ${expected}], found [Chunk ${index}].`);
    currentIndex = index;
  });
  finish();
  if (!prompts.length) throw new Error("No legacy [Chunk N] sections were found.");
  if (expectedChunks != null && prompts.length !== expectedChunks) {
    throw new Error(`Expected ${expectedChunks} legacy chunks, found ${prompts.length}.`);
  }
  return prompts;
}

function inventoryIdentityItem(item = {}) {
  return {
    role: item.role == null ? null : String(item.role),
    kind: item.kind == null ? null : String(item.kind),
    source: item.source == null ? null : String(item.source),
    visible_to_model: Boolean(item.visible_to_model),
    tag: item.tag == null ? null : String(item.tag),
    input_name: item.input_name == null ? null : String(item.input_name),
    source_node_id: item.source_node_id == null ? null : String(item.source_node_id),
    source_node_class: item.source_node_class == null ? null : String(item.source_node_class),
    source_output_name: item.source_output_name == null ? null : String(item.source_output_name),
    source_slot: Number.isInteger(item.source_slot) ? item.source_slot : null,
    source_identity: item.source_identity == null ? null : String(item.source_identity),
    model_asset_id: item.model_asset_id == null ? null : String(item.model_asset_id),
  };
}

export function continuumInventoryIdentity(inventory) {
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  return {
    schema_version: Number(inventory?.schema_version ?? 1),
    items: items.map(inventoryIdentityItem),
  };
}

export function sameContinuumReferenceInventory(savedInventory, activeInventory) {
  const saved = continuumInventoryIdentity(savedInventory);
  const active = continuumInventoryIdentity(activeInventory);
  if (saved.schema_version !== active.schema_version || saved.items.length !== active.items.length) return false;

  return saved.items.every((savedValue, index) => {
    const activeValue = active.items[index];
    if (
      Boolean(savedValue.model_asset_id) !== savedValue.visible_to_model
      || Boolean(activeValue.model_asset_id) !== activeValue.visible_to_model
    ) return false;

    const savedSourceIdentity = savedValue.source_identity;
    const activeSourceIdentity = activeValue.source_identity;
    const savedModelAssetId = savedValue.model_asset_id;
    const activeModelAssetId = activeValue.model_asset_id;

    const savedItem = { ...savedValue, source_identity: null, model_asset_id: null };
    const activeItem = { ...activeValue, source_identity: null, model_asset_id: null };
    if (JSON.stringify(savedItem) !== JSON.stringify(activeItem)) return false;

    // Inventories saved before source_identity existed use null as an unknown
    // legacy identity. Once a saved fingerprint exists, it must match strictly.
    if (savedSourceIdentity != null && savedSourceIdentity !== activeSourceIdentity) return false;

    // model_asset_id is a temporary Writer-session handle. A different ID is
    // safe only when a stable saved workflow fingerprint proves both copies
    // came from the same downstream source.
    if (
      savedModelAssetId !== activeModelAssetId
      && (savedSourceIdentity == null || savedSourceIdentity !== activeSourceIdentity)
    ) return false;
    return true;
  });
}


export function sequenceStateFromResult(result) {
  const sequence = result?.sequence;
  const settings = normalizeContinuumSettings(sequence?.settings || {});
  if (sequence?.schema_version !== CONTINUUM_SCHEMA_VERSION || !sequence?.plan || !Array.isArray(sequence?.chunks)) {
    throw new Error("The generated Continuum response has no valid structural sequence state.");
  }
  const preamble = typeof sequence?.preamble === "string" ? sequence.preamble.trim() : "";
  const prompts = sequence.chunks.map((chunk, offset) => {
    const body = typeof chunk?.body === "string" ? chunk.body : chunk?.prompt;
    if (chunk?.index !== offset + 1 || typeof body !== "string" || !body.trim()) {
      throw new Error(`Generated Continuum Chunk ${offset + 1} is invalid.`);
    }
    return body.trim();
  });
  if (prompts.length !== settings.chunks) throw new Error("Generated Continuum chunk count does not match its settings.");
  const prompt = serializeContinuumPrompts(prompts, { preamble, chunkSeconds: settings.chunk_seconds });
  if (prompt !== result.prompt) throw new Error("Generated Continuum canonical Timeline text does not match its structural state.");
  const downstreamReferenceInventory = sequence?.downstream_reference_inventory ?? null;
  if (
    downstreamReferenceInventory != null
    && (!Array.isArray(downstreamReferenceInventory?.items) || Number(downstreamReferenceInventory?.schema_version ?? 1) !== 1)
  ) {
    throw new Error("Generated Continuum response has an invalid downstream conditioning inventory snapshot.");
  }
  return {
    schema_version: CONTINUUM_SCHEMA_VERSION,
    settings,
    plan: sequence.plan,
    preamble,
    prompts,
    downstream_reference_inventory: downstreamReferenceInventory,
  };
}

export function continuumDraftOutput(value) {
  if (value?.raw_prompt != null) return String(value.raw_prompt);
  const settings = normalizeContinuumSettings(value?.settings || {});
  const preamble = typeof value?.preamble === "string"
    ? value.preamble
    : typeof value?.plan?.global?.sequence_preamble === "string"
      ? value.plan.global.sequence_preamble
      : "";
  return serializeContinuumPrompts(value?.prompts || [], { preamble, chunkSeconds: settings.chunk_seconds });
}

export function updateContinuumDraftFromEditor(value, script) {
  const settings = normalizeContinuumSettings(value?.settings || {});
  try {
    const parsed = parseContinuumTimeline(script, {
      expectedChunks: settings.chunks,
      chunkSeconds: settings.chunk_seconds,
    });
    return {
      ...value,
      schema_version: CONTINUUM_SCHEMA_VERSION,
      settings,
      preamble: parsed.preamble,
      prompts: parsed.prompts,
      raw_prompt: null,
    };
  } catch (timelineError) {
    const mayMigrateLegacy = value?.schema_version === LEGACY_CONTINUUM_SCHEMA_VERSION
      || value?.migrated_from_schema_version === LEGACY_CONTINUUM_SCHEMA_VERSION
      || !value?.schema_version;
    if (mayMigrateLegacy) {
      try {
        const prompts = parseLegacyChunkPrompts(script, settings.chunks);
        return {
          ...value,
          schema_version: CONTINUUM_SCHEMA_VERSION,
          settings,
          preamble: "",
          prompts,
          raw_prompt: null,
          migrated_from_schema_version: LEGACY_CONTINUUM_SCHEMA_VERSION,
        };
      } catch {
        // Keep malformed manual text verbatim. It cannot be applied until corrected.
      }
    }
    return {
      ...value,
      schema_version: CONTINUUM_SCHEMA_VERSION,
      settings,
      raw_prompt: String(script),
      timeline_error: String(timelineError?.message || timelineError),
    };
  }
}

function nodeClassId(node) {
  return node?.comfyClass || node?.type || node?.properties?.["Node name for S&R"] || "";
}

function inputNames(node) {
  return new Set((node?.inputs || []).map((input) => input?.name));
}

function widget(node, name) {
  return (node?.widgets || []).find((candidate) => candidate?.name === name) || null;
}

export function isCompatibleContinuumSampler(node) {
  if (!CONTINUUM_SAMPLER_NODE_IDS.has(nodeClassId(node))) return false;
  const inputs = inputNames(node);
  return (
    inputs.has("sequence_prompt")
    && widget(node, "prompt_mode") != null
    && widget(node, "chunks") != null
    && widget(node, "chunk_seconds") != null
  );
}

export function compatibleContinuumSamplers(graph) {
  return (graph?._nodes || []).filter(isCompatibleContinuumSampler);
}

function selectedNodes(canvas) {
  const selected = canvas?.selected_nodes ?? canvas?.selectedItems;
  if (selected instanceof Map) return [...selected.values()];
  if (Array.isArray(selected)) return selected;
  if (selected && typeof selected === "object") return Object.values(selected);
  return [];
}

export function chooseContinuumSampler(app) {
  const candidates = compatibleContinuumSamplers(app?.graph);
  if (!candidates.length) return { status: "missing", candidates };
  if (candidates.length === 1) return { status: "selected", sampler: candidates[0], candidates };
  const selected = selectedNodes(app?.canvas).filter((node) => candidates.includes(node));
  if (selected.length === 1) return { status: "selected", sampler: selected[0], candidates };
  return { status: "multiple", candidates };
}

function graphLink(graph, linkId) {
  if (linkId == null) return null;
  if (graph?.links instanceof Map) return graph.links.get(linkId) || null;
  return graph?.links?.[linkId] || null;
}

function graphNode(graph, nodeId) {
  return graph?.getNodeById?.(nodeId) || (graph?._nodes || []).find((node) => node?.id === nodeId) || null;
}

const NODE_MODE_NEVER = 2;
const NODE_MODE_BYPASS = 4;

const IMAGE_CONVEYOR_NODE_IDS = new Set(["ImageConveyor", "SequentialBatchImageLoader"]);
const IMAGE_CONVEYOR_OUTPUT_MODE_PERSISTENT = "persistent_refs";
const IMAGE_CONVEYOR_OUTPUT_MODE_QUEUE_GROUP = "queue_group";
const IMAGE_CONVEYOR_REFERENCE_SLOTS = 8;
const IMAGE_CONVEYOR_MAX_GROUP_IMAGES = 9;
const IMAGE_CONVEYOR_REFERENCE_OUTPUT_START = 6;
const IMAGE_CONVEYOR_LAST_FRAME_OUTPUT = 14;
const IMAGE_CONVEYOR_REFERENCE_PROPERTY = "image_conveyor_reference_enabled";
const IMAGE_CONVEYOR_MAIN_PROPERTY = "image_conveyor_main_enabled";
const IMAGE_CONVEYOR_LAST_FRAME_PROPERTY = "image_conveyor_last_frame_enabled";
const SCALE_IMAGE_TOTAL_PIXELS_X_NODE_CLASS = "ImageScaleToTotalPixelsX";
const SCALE_IMAGE_TOTAL_PIXELS_X_CONTRACT_SHA = "79e831097bb7a76ade3a28359300e62332086c42";
const SCALE_IMAGE_TOTAL_PIXELS_X_PLAN_VERSION = 1;

function jsonObject(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function imageConveyorState(node) {
  const serialized = jsonObject(widget(node, "state_json")?.value);
  const live = node?.__bil?.state;
  const liveState = live && typeof live === "object" && !Array.isArray(live) ? live : null;
  if (!serialized && !liveState) {
    throw new Error(`Image Conveyor ${String(node?.id ?? "")} has no readable state_json; Continuum reference topology cannot be resolved safely.`);
  }
  return { ...(serialized || {}), ...(liveState || {}) };
}

function normalizedConveyorGroupSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(IMAGE_CONVEYOR_MAX_GROUP_IMAGES, Math.trunc(number)));
}

function imageConveyorOutputMode(state) {
  if (Object.hasOwn(state, "output_mode")) {
    return String(state.output_mode ?? "").trim().toLowerCase() === IMAGE_CONVEYOR_OUTPUT_MODE_QUEUE_GROUP
      ? IMAGE_CONVEYOR_OUTPUT_MODE_QUEUE_GROUP
      : IMAGE_CONVEYOR_OUTPUT_MODE_PERSISTENT;
  }
  return normalizedConveyorGroupSize(state.images_per_execution) > 1
    ? IMAGE_CONVEYOR_OUTPUT_MODE_QUEUE_GROUP
    : IMAGE_CONVEYOR_OUTPUT_MODE_PERSISTENT;
}

function explicitConveyorToggle(node, state, propertyName, stateName) {
  if (node?.properties && Object.hasOwn(node.properties, propertyName)) {
    return node.properties[propertyName] !== false;
  }
  if (Object.hasOwn(state, stateName)) return state[stateName] !== false;
  return true;
}

function imageConveyorReferenceEnabled(node, state, index) {
  const propertyMask = node?.properties?.[IMAGE_CONVEYOR_REFERENCE_PROPERTY];
  const stateMask = state.reference_output_enabled;
  const mask = Array.isArray(propertyMask) ? propertyMask : Array.isArray(stateMask) ? stateMask : null;
  return mask?.[index] !== false;
}

function imageConveyorOutputName(connection) {
  const explicit = String(connection?.output?.name ?? connection?.output?.label ?? "").trim();
  if (explicit) return explicit;
  const slot = Number(connection?.link?.origin_slot);
  if (slot === 0) return "image";
  if (slot >= IMAGE_CONVEYOR_REFERENCE_OUTPUT_START && slot < IMAGE_CONVEYOR_REFERENCE_OUTPUT_START + IMAGE_CONVEYOR_REFERENCE_SLOTS) {
    return `ref_image_${slot - IMAGE_CONVEYOR_REFERENCE_OUTPUT_START + 1}`;
  }
  if (slot === IMAGE_CONVEYOR_LAST_FRAME_OUTPUT) return "last_frame";
  return "";
}

function imageConveyorReferenceOutputIndex(outputName) {
  const match = /^ref_image_([1-8])$/.exec(outputName);
  return match ? Number(match[1]) - 1 : -1;
}

function imageConveyorOutputIsActive(connection) {
  const node = connection?.source;
  if (!IMAGE_CONVEYOR_NODE_IDS.has(nodeClassId(node))) return true;

  const state = imageConveyorState(node);
  const mode = imageConveyorOutputMode(state);
  const outputName = imageConveyorOutputName(connection);
  const referenceIndex = imageConveyorReferenceOutputIndex(outputName);

  if (mode === IMAGE_CONVEYOR_OUTPUT_MODE_QUEUE_GROUP) {
    const count = normalizedConveyorGroupSize(state.images_per_execution);
    if (outputName === "image") return count >= 1;
    if (outputName === "last_frame") return count >= 2;
    if (referenceIndex >= 0) return referenceIndex + 2 <= count;
    return true;
  }

  if (outputName === "image") {
    return explicitConveyorToggle(node, state, IMAGE_CONVEYOR_MAIN_PROPERTY, "main_output_enabled");
  }
  if (outputName === "last_frame") {
    return explicitConveyorToggle(node, state, IMAGE_CONVEYOR_LAST_FRAME_PROPERTY, "last_frame_output_enabled");
  }
  if (referenceIndex >= 0) {
    if (!imageConveyorReferenceEnabled(node, state, referenceIndex)) return false;
    const slots = Array.isArray(state.reference_slots) ? state.reference_slots : [];
    return slots[referenceIndex] != null;
  }
  return true;
}

function imageConveyorOriginForConnection(graph, connection, visited = new Set()) {
  const source = connection?.source;
  if (!source) return null;
  if (IMAGE_CONVEYOR_NODE_IDS.has(nodeClassId(source))) return connection;

  const sourceSlot = Number(connection?.link?.origin_slot);
  const key = `${String(source.id ?? "")}:${Number.isFinite(sourceSlot) ? sourceSlot : "?"}`;
  if (visited.has(key)) return null;
  visited.add(key);

  const outputType = connection?.output?.type ?? "IMAGE";
  if (!slotTypesCompatible(outputType, "IMAGE")) return null;

  const candidates = (source.inputs || []).filter((input) => (
    input?.link != null
    && slotTypesCompatible(input.type, outputType)
    && slotTypesCompatible(input.type, "IMAGE")
  ));
  if (candidates.length !== 1) return null;

  const input = candidates[0];
  const upstream = resolveSourceConnection(graph, input.link, input.type ?? outputType);
  if (!upstream) return null;
  return imageConveyorOriginForConnection(graph, { input, ...upstream }, visited);
}

function connectionIsEffectivelyActive(graph, connection) {
  if (!connection) return false;
  const conveyorOrigin = imageConveyorOriginForConnection(graph, connection);
  return conveyorOrigin ? imageConveyorOutputIsActive(conveyorOrigin) : true;
}

function opaqueStateFingerprint(value) {
  const text = String(value ?? "");
  let first = (0xdeadbeef ^ text.length) >>> 0;
  let second = (0x41c6ce57 ^ text.length) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761) >>> 0;
    second = Math.imul(second ^ code, 1597334677) >>> 0;
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) >>> 0;
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) >>> 0;
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`;
}

function imageConveyorSourceIdentityDescriptor(graph, connection) {
  const conveyorOrigin = imageConveyorOriginForConnection(graph, connection);
  if (!conveyorOrigin) return {};
  const state = imageConveyorState(conveyorOrigin.source);
  if (imageConveyorOutputMode(state) !== IMAGE_CONVEYOR_OUTPUT_MODE_PERSISTENT) return {};
  const referenceIndex = imageConveyorReferenceOutputIndex(imageConveyorOutputName(conveyorOrigin));
  if (referenceIndex < 0) return {};
  const slot = Array.isArray(state.reference_slots) ? state.reference_slots[referenceIndex] : null;
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return {};
  const stableSlot = JSON.stringify([
    String(slot.annotated ?? ""),
    String(slot.filename ?? ""),
    String(slot.subfolder ?? ""),
    String(slot.type ?? ""),
  ]);
  return {
    source_identity: `image-conveyor-ref-v1:${opaqueStateFingerprint(stableSlot)}`,
  };
}

function safeWorkflowPath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return "";
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  return parts.join("/");
}

function normalizedWorkflowImageFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const typeValue = String(value.type ?? "input").trim().toLowerCase();
  const type = ["input", "output", "temp"].includes(typeValue) ? typeValue : "input";
  let filename = safeWorkflowPath(value.filename);
  let subfolder = safeWorkflowPath(value.subfolder);
  const annotated = String(value.annotated ?? "").trim();

  if (!filename && annotated) {
    const suffix = annotated.match(/ \[(input|output|temp)\]$/i);
    const annotatedPath = safeWorkflowPath(suffix ? annotated.slice(0, suffix.index) : annotated);
    if (annotatedPath) {
      const parts = annotatedPath.split("/");
      filename = parts.pop() || "";
      subfolder = parts.join("/");
    }
  } else if (filename && filename.includes("/") && !subfolder) {
    const parts = filename.split("/");
    filename = parts.pop() || "";
    subfolder = parts.join("/");
  }
  if (!filename || filename.includes("/")) return null;
  return { filename, subfolder, type };
}

function directLoadImageWorkflowMedia(connection) {
  const source = connection?.source;
  if (nodeClassId(source) !== "LoadImage") return null;
  const selected = widget(source, "image")?.value;
  if (typeof selected !== "string" || !selected.trim()) return null;
  const file = normalizedWorkflowImageFile({ annotated: selected, type: "input" });
  if (!file) return null;
  const stableFile = JSON.stringify([file.filename, file.subfolder, file.type]);
  return {
    importable: true,
    source_kind: "load_image",
    source_label: "Load Image",
    source_identity: `load-image-v1:${opaqueStateFingerprint(stableFile)}`,
    file,
  };
}

function imageConveyorWorkflowMedia(graph, connection) {
  const conveyorOrigin = imageConveyorOriginForConnection(graph, connection);
  if (!conveyorOrigin) return null;
  const state = imageConveyorState(conveyorOrigin.source);
  const mode = imageConveyorOutputMode(state);
  const outputName = imageConveyorOutputName(conveyorOrigin);
  const referenceIndex = imageConveyorReferenceOutputIndex(outputName);

  if (mode === IMAGE_CONVEYOR_OUTPUT_MODE_QUEUE_GROUP) {
    return {
      importable: false,
      reason: "dynamic_queue_group",
      source_kind: "image_conveyor_queue_group",
      source_label: outputName || "Image Conveyor queue output",
    };
  }
  if (referenceIndex < 0) {
    return {
      importable: false,
      reason: "queue_driven_output",
      source_kind: "image_conveyor_queue_output",
      source_label: outputName || "Image Conveyor queue output",
    };
  }

  const direct = (
    conveyorOrigin.source === connection.source
    && Number(conveyorOrigin.link?.origin_slot) === Number(connection.link?.origin_slot)
  );
  if (!direct) {
    return {
      importable: false,
      reason: "processed_image_chain",
      source_kind: "image_conveyor_processed",
      source_label: `Image Conveyor Ref ${referenceIndex + 1}`,
    };
  }

  const slot = Array.isArray(state.reference_slots) ? state.reference_slots[referenceIndex] : null;
  const file = normalizedWorkflowImageFile(slot);
  if (!file) {
    return {
      importable: false,
      reason: "unreadable_reference_file",
      source_kind: "image_conveyor_persistent",
      source_label: `Image Conveyor Ref ${referenceIndex + 1}`,
    };
  }
  return {
    importable: true,
    source_kind: "image_conveyor_persistent",
    source_label: `Image Conveyor Ref ${referenceIndex + 1}`,
    source_identity: imageConveyorSourceIdentityDescriptor(graph, connection).source_identity ?? null,
    file,
  };
}

function scaleImageToTotalPixelsXPlan(node) {
  if (nodeClassId(node) !== SCALE_IMAGE_TOTAL_PIXELS_X_NODE_CLASS) return null;
  const dynamicParameter = (node?.inputs || []).find((input) => (
    ["width", "height", "megapixels", "multiple_of", "resize_mode", "upscale_method"].includes(input?.name)
    && input?.link != null
  ));
  if (dynamicParameter) {
    return {
      supported: false,
      reason: "dynamic_transform_parameters",
      dynamic_parameter: String(dynamicParameter.name),
    };
  }

  const megapixels = Number(widget(node, "megapixels")?.value);
  const multipleOf = Number(widget(node, "multiple_of")?.value);
  const resizeMode = String(widget(node, "resize_mode")?.value ?? "").trim().toLowerCase();
  const upscaleMethod = String(widget(node, "upscale_method")?.value ?? "").trim().toLowerCase();
  if (
    !Number.isFinite(megapixels)
    || megapixels < 0
    || megapixels > 16
    || !Number.isInteger(multipleOf)
    || multipleOf < 1
    || multipleOf > 128
    || !["stretch", "crop", "pad"].includes(resizeMode)
  ) {
    return { supported: false, reason: "unsupported_transform_configuration" };
  }
  if (upscaleMethod !== "lanczos") {
    return { supported: false, reason: "unsupported_transform_method" };
  }
  return {
    supported: true,
    plan: {
      kind: "image_scale_to_total_pixels_x",
      version: SCALE_IMAGE_TOTAL_PIXELS_X_PLAN_VERSION,
      node_class: SCALE_IMAGE_TOTAL_PIXELS_X_NODE_CLASS,
      contract_sha: SCALE_IMAGE_TOTAL_PIXELS_X_CONTRACT_SHA,
      megapixels,
      multiple_of: multipleOf,
      resize_mode: resizeMode,
      upscale_method: upscaleMethod,
    },
  };
}

function directStableWorkflowImageMedia(graph, connection) {
  const conveyor = imageConveyorWorkflowMedia(graph, connection);
  if (conveyor?.importable) return conveyor;
  const directLoadImage = directLoadImageWorkflowMedia(connection);
  if (directLoadImage?.importable) return directLoadImage;
  return conveyor || directLoadImage || null;
}

function scaleImageToTotalPixelsXWorkflowMedia(graph, connection) {
  const node = connection?.source;
  if (nodeClassId(node) !== SCALE_IMAGE_TOTAL_PIXELS_X_NODE_CLASS) return null;
  if (Number(connection?.link?.origin_slot) !== 0) {
    return {
      importable: false,
      reason: "unsupported_transform_output",
      source_kind: "scale_image_to_total_pixels_x",
      source_label: "Scale Image to Total Pixels Adv",
    };
  }

  const planState = scaleImageToTotalPixelsXPlan(node);
  if (!planState?.supported) {
    return {
      importable: false,
      reason: planState?.reason || "unsupported_transform_configuration",
      source_kind: "scale_image_to_total_pixels_x",
      source_label: "Scale Image to Total Pixels Adv",
    };
  }

  const imageInput = (node?.inputs || []).find((input) => input?.name === "image");
  const upstream = imageInput?.link == null
    ? null
    : resolveSourceConnection(graph, imageInput.link, imageInput.type ?? "IMAGE");
  if (!upstream) {
    return {
      importable: false,
      reason: "missing_transform_source",
      source_kind: "scale_image_to_total_pixels_x",
      source_label: "Scale Image to Total Pixels Adv",
    };
  }
  const source = directStableWorkflowImageMedia(graph, { input: imageInput, ...upstream });
  if (!source?.importable || !source.file || !source.source_identity) {
    return {
      importable: false,
      reason: "unsupported_transform_source",
      source_kind: "scale_image_to_total_pixels_x",
      source_label: "Scale Image to Total Pixels Adv",
    };
  }

  const materializationPlan = planState.plan;
  const sourceIdentity = `workflow-materialized-v1:${opaqueStateFingerprint(JSON.stringify([
    source.source_identity,
    materializationPlan,
  ]))}`;
  return {
    ...source,
    importable: true,
    source_kind: "scale_image_to_total_pixels_x",
    source_label: `${source.source_label} → Scale Image to Total Pixels Adv`,
    source_identity: sourceIdentity,
    materialization_plan: materializationPlan,
  };
}

function workflowImageMediaDescriptor(graph, connection) {
  const materialized = scaleImageToTotalPixelsXWorkflowMedia(graph, connection);
  if (materialized) return materialized;
  const conveyor = imageConveyorWorkflowMedia(graph, connection);
  if (conveyor) return conveyor;
  const directLoadImage = directLoadImageWorkflowMedia(connection);
  if (directLoadImage) return directLoadImage;
  return {
    importable: false,
    reason: "unsupported_runtime_source",
    source_kind: String(nodeClassId(connection?.source) || "workflow"),
    source_label: String(nodeClassId(connection?.source) || "Workflow image"),
  };
}

function workflowSourceIdentityDescriptor(graph, connection) {
  const materialized = scaleImageToTotalPixelsXWorkflowMedia(graph, connection);
  if (materialized?.source_identity) return { source_identity: materialized.source_identity };
  const conveyor = imageConveyorSourceIdentityDescriptor(graph, connection);
  if (conveyor.source_identity) return conveyor;
  const directLoadImage = directLoadImageWorkflowMedia(connection);
  return directLoadImage?.source_identity ? { source_identity: directLoadImage.source_identity } : {};
}

function slotTypesCompatible(inputType, outputType) {
  const liteGraph = globalThis.LiteGraph;
  if (typeof liteGraph?.isValidConnection === "function") {
    return Boolean(liteGraph.isValidConnection(inputType, outputType));
  }
  return inputType === outputType || inputType === "*" || outputType === "*" || inputType === "" || outputType === "";
}

function bypassInputIndex(node, outputSlot, targetType) {
  const inputs = node?.inputs || [];
  const outputType = node?.outputs?.[outputSlot]?.type ?? targetType;
  if (targetType === "*" || targetType === "") return inputs.length > outputSlot ? outputSlot : (inputs.length ? 0 : -1);

  const opposite = inputs[outputSlot];
  if (
    opposite
    && slotTypesCompatible(opposite.type, outputType)
    && slotTypesCompatible(opposite.type, targetType)
  ) {
    return outputSlot;
  }

  const exact = inputs.findIndex((candidate) => candidate?.type === targetType);
  if (exact !== -1) return exact;
  return inputs.findIndex(
    (candidate) => slotTypesCompatible(candidate?.type, outputType) && slotTypesCompatible(candidate?.type, targetType),
  );
}

function resolveSourceConnection(graph, linkId, targetType, visited = new Set()) {
  if (linkId == null || visited.has(linkId)) return null;
  visited.add(linkId);
  const link = graphLink(graph, linkId);
  if (!link) return null;
  const source = graphNode(graph, link.origin_id);
  if (!source) return null;

  const mode = Number(source.mode ?? 0);
  if (mode === NODE_MODE_NEVER) return null;
  if (mode === NODE_MODE_BYPASS) {
    const inputIndex = bypassInputIndex(source, Number(link.origin_slot), targetType);
    if (inputIndex < 0) return null;
    const bypassInput = source.inputs?.[inputIndex];
    if (!bypassInput || bypassInput.link == null) return null;
    return resolveSourceConnection(graph, bypassInput.link, targetType, visited);
  }

  const output = source.outputs?.[link.origin_slot] || null;
  return { link, source, output };
}

function sourceForInput(graph, node, inputName) {
  const input = (node?.inputs || []).find((candidate) => candidate?.name === inputName);
  if (!input || input.link == null) return null;
  const resolved = resolveSourceConnection(graph, input.link, input.type);
  return resolved ? { input, ...resolved } : null;
}

function sourceDescriptor(connection) {
  return {
    source_node_id: connection.source.id,
    source_node_class: nodeClassId(connection.source),
    source_output_name: String(connection.output?.name ?? connection.link.origin_slot),
    source_slot: Number(connection.link.origin_slot),
  };
}

export function discoverContinuumReferenceInventory(app, sampler) {
  if (!isCompatibleContinuumSampler(sampler)) throw new Error("Select a supported H3 Continuum sampler (V3.4–V3.7).");
  const graph = app?.graph;
  const items = [];

  const referenceConnections = CONTINUUM_REFERENCE_INPUTS
    .map((inputName) => ({ inputName, connection: sourceForInput(graph, sampler, inputName) }))
    .filter((item) => item.connection && connectionIsEffectivelyActive(graph, item.connection));

  referenceConnections.forEach(({ inputName, connection }, offset) => {
    items.push({
      tag: `<Picture ${offset + 1}>`,
      kind: "image",
      source: "workflow",
      visible_to_model: false,
      role: "reference_image",
      input_name: inputName,
      ...sourceDescriptor(connection),
      ...workflowSourceIdentityDescriptor(graph, connection),
    });
  });

  const roleConnections = new Map(
    [...CONDITIONING_ROLES].map(([inputName, role]) => {
      const connection = sourceForInput(graph, sampler, inputName);
      return [
        inputName,
        { role, connection: connection && connectionIsEffectivelyActive(graph, connection) ? connection : null },
      ];
    }),
  );
  const hasReferenceImages = referenceConnections.length > 0;
  let keyframePictureIndex = 0;

  for (const [inputName, { role, connection }] of roleConnections) {
    if (!connection) continue;
    let tag = null;
    if (!hasReferenceImages && (role.role === "first_frame" || role.role === "last_frame")) {
      keyframePictureIndex += 1;
      tag = `<Picture ${keyframePictureIndex}>`;
    } else if (role.role === "video_reference") {
      tag = "<Video 1>";
    } else if (role.role === "reference_audio") {
      tag = "<Audio 1>";
    }
    items.push({
      ...(tag ? { tag } : {}),
      kind: role.kind,
      source: "workflow",
      visible_to_model: false,
      role: role.role,
      input_name: inputName,
      ...sourceDescriptor(connection),
      ...workflowSourceIdentityDescriptor(graph, connection),
    });
  }

  return { schema_version: 1, items };
}

export function continuumReferenceBindingKey(item = {}) {
  return JSON.stringify([
    item.role == null ? null : String(item.role),
    item.input_name == null ? null : String(item.input_name),
    item.source_node_id == null ? null : String(item.source_node_id),
    item.source_node_class == null ? null : String(item.source_node_class),
    item.source_output_name == null ? null : String(item.source_output_name),
    Number.isInteger(item.source_slot) ? item.source_slot : null,
  ]);
}

function workflowImageRoleLabel(item) {
  if (item?.tag) return String(item.tag);
  if (item?.role === "first_frame") return "First Frame";
  if (item?.role === "last_frame") return "Last Frame";
  return "Workflow image";
}

export function discoverContinuumWorkflowImageMedia(app, sampler) {
  const inventory = discoverContinuumReferenceInventory(app, sampler);
  const graph = app?.graph;
  const candidates = inventory.items
    .filter((item) => item?.kind === "image" && ["reference_image", "first_frame", "last_frame"].includes(item?.role))
    .map((item) => {
      const connection = sourceForInput(graph, sampler, item.input_name);
      const media = connection
        ? workflowImageMediaDescriptor(graph, connection)
        : { importable: false, reason: "missing_connection", source_kind: "workflow", source_label: "Workflow image" };
      return {
        key: continuumReferenceBindingKey(item),
        label: workflowImageRoleLabel(item),
        role: item.role,
        input_name: item.input_name,
        tag: item.tag ?? null,
        source_node_id: item.source_node_id,
        source_node_class: item.source_node_class,
        source_output_name: item.source_output_name,
        source_slot: item.source_slot,
        source_identity: item.source_identity ?? media.source_identity ?? null,
        ...media,
      };
    });
  return { inventory, candidates };
}

function bindingValue(bindings, key) {
  if (bindings instanceof Map) return bindings.get(key) ?? null;
  if (bindings && typeof bindings === "object") return bindings[key] ?? null;
  return null;
}

export function bindContinuumReferenceMedia(inventory, bindings, assets = []) {
  const assetIds = new Set(
    (Array.isArray(assets) ? assets : [])
      .map((asset) => String(asset?.id ?? ""))
      .filter(Boolean),
  );
  const items = (Array.isArray(inventory?.items) ? inventory.items : []).map((item) => {
    const binding = bindingValue(bindings, continuumReferenceBindingKey(item));
    const assetId = String(binding?.asset_id ?? "");
    const sourceIdentity = item?.source_identity == null ? null : String(item.source_identity);
    const bindingIdentity = binding?.source_identity == null ? null : String(binding.source_identity);
    const identityMatches = sourceIdentity == null
      ? bindingIdentity == null
      : sourceIdentity === bindingIdentity;
    if (!assetId || !assetIds.has(assetId) || !identityMatches) {
      const result = { ...item, visible_to_model: false };
      delete result.model_asset_id;
      return result;
    }
    return {
      ...item,
      visible_to_model: true,
      model_asset_id: assetId,
    };
  });
  return {
    schema_version: Number(inventory?.schema_version ?? 1),
    items,
  };
}

function workflowInventoryIdentityItem(item = {}) {
  const identity = inventoryIdentityItem(item);
  delete identity.visible_to_model;
  delete identity.model_asset_id;
  return identity;
}

export function sameContinuumWorkflowSourceInventory(savedInventory, activeInventory) {
  const saved = {
    schema_version: Number(savedInventory?.schema_version ?? 1),
    items: (Array.isArray(savedInventory?.items) ? savedInventory.items : []).map(workflowInventoryIdentityItem),
  };
  const active = {
    schema_version: Number(activeInventory?.schema_version ?? 1),
    items: (Array.isArray(activeInventory?.items) ? activeInventory.items : []).map(workflowInventoryIdentityItem),
  };
  if (saved.schema_version !== active.schema_version || saved.items.length !== active.items.length) return false;
  return saved.items.every((savedValue, index) => {
    const activeValue = active.items[index];
    const savedSourceIdentity = savedValue.source_identity;
    const activeSourceIdentity = activeValue.source_identity;
    const savedItem = { ...savedValue, source_identity: null };
    const activeItem = { ...activeValue, source_identity: null };
    if (JSON.stringify(savedItem) !== JSON.stringify(activeItem)) return false;
    return savedSourceIdentity == null || savedSourceIdentity === activeSourceIdentity;
  });
}


export function validateContinuumModeTopology(mode, inventory) {
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  const actual = {
    first_frame: items.some((item) => item?.role === "first_frame"),
    last_frame: items.some((item) => item?.role === "last_frame"),
    reference_images: items.filter((item) => item?.role === "reference_image").length,
  };
  if (mode === "Reference") {
    return { valid: true, mode, required: null, actual };
  }
  const expected = {
    T2VA: [false, false],
    I2VA: [true, false],
    FL2VA: [true, true],
    L2VA: [false, true],
  };
  const requiredPair = expected[mode];
  if (!requiredPair) {
    return { valid: false, mode, reason: "unsupported_mode", actual };
  }
  const required = {
    first_frame: requiredPair[0],
    last_frame: requiredPair[1],
    reference_images: mode === "T2VA" ? 0 : null,
  };
  const keyframesMatch = (
    actual.first_frame === required.first_frame
    && actual.last_frame === required.last_frame
  );
  const referencesMatch = mode !== "T2VA" || actual.reference_images === 0;
  const valid = keyframesMatch && referencesMatch;
  const reason = !referencesMatch
    ? "reference_images_require_reference_mode"
    : !keyframesMatch
      ? "temporal_keyframe_mismatch"
      : null;
  return { valid, mode, required, actual, reason };
}


function publicReferenceTags(text) {
  const found = new Set();
  const pattern = /<\s*(Picture|Video|Audio)\s+(\d+)\s*>/gi;
  for (const match of String(text ?? "").matchAll(pattern)) {
    const number = Number(match[2]);
    if (Number.isInteger(number) && number > 0) {
      const kind = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
      found.add(`<${kind} ${number}>`);
    }
  }
  return found;
}

function sortedTags(values) {
  return [...values].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function validateContinuumReferenceScope(inventory, preamble, prompts) {
  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  const bodies = Array.isArray(prompts) ? prompts : [];
  const expected = new Set(items.filter((item) => item?.tag).map((item) => String(item.tag)));
  const persistent = new Set(
    items
      .filter((item) => item?.tag && (
        bodies.length === 1
        || item.role === "reference_image"
        || item.role === "video_reference"
        || item.role === "reference_audio"
      ))
      .map((item) => String(item.tag)),
  );
  const scopes = bodies.map((_prompt, index) => {
    const allowed = new Set();
    items.forEach((item) => {
      if (!item?.tag) return;
      if (item.role === "reference_image" || item.role === "video_reference" || item.role === "reference_audio") {
        allowed.add(String(item.tag));
      } else if (item.role === "first_frame" && index === 0) {
        allowed.add(String(item.tag));
      } else if (item.role === "last_frame" && index === bodies.length - 1) {
        allowed.add(String(item.tag));
      }
    });
    return allowed;
  });

  const violations = [];
  const globalRefs = publicReferenceTags(preamble);
  const undeclaredGlobal = new Set([...globalRefs].filter((tag) => !expected.has(tag)));
  if (undeclaredGlobal.size) {
    violations.push({
      kind: "undeclared",
      scope: "global",
      tags: sortedTags(undeclaredGlobal),
      allowed: sortedTags(expected),
    });
  }
  const scopedGlobal = new Set(
    [...globalRefs].filter((tag) => expected.has(tag) && !persistent.has(tag)),
  );
  if (scopedGlobal.size) {
    violations.push({
      kind: "scope",
      scope: "global",
      tags: sortedTags(scopedGlobal),
      allowed: sortedTags(persistent),
    });
  }

  bodies.forEach((prompt, index) => {
    const refs = publicReferenceTags(prompt);
    const undeclared = new Set([...refs].filter((tag) => !expected.has(tag)));
    if (undeclared.size) {
      violations.push({
        kind: "undeclared",
        scope: "chunk",
        chunk_index: index + 1,
        tags: sortedTags(undeclared),
        allowed: sortedTags(expected),
      });
    }
    const scoped = new Set(
      [...refs].filter((tag) => expected.has(tag) && !scopes[index].has(tag)),
    );
    if (scoped.size) {
      violations.push({
        kind: "scope",
        scope: "chunk",
        chunk_index: index + 1,
        tags: sortedTags(scoped),
        allowed: sortedTags(scopes[index]),
      });
    }
  });

  return {
    valid: violations.length === 0,
    violations,
    expected: sortedTags(expected),
    persistent: sortedTags(persistent),
    chunk_scopes: scopes.map(sortedTags),
  };
}


function editableMultilineWidget(node) {
  if (!EDITABLE_MULTILINE_NODE_IDS.has(nodeClassId(node))) return null;
  const valueWidget = widget(node, "value") || (node?.widgets || []).find((candidate) => typeof candidate?.value === "string");
  const stringOutput = (node?.outputs || []).some((output) => output?.type === "STRING");
  return stringOutput && valueWidget ? valueWidget : null;
}

export function connectedSequenceTextSource(graph, sampler) {
  const input = (sampler?.inputs || []).find((candidate) => candidate?.name === "sequence_prompt");
  if (!input || input.link == null) return { status: "unconnected" };
  let link = graphLink(graph, input.link);
  const visited = new Set();
  while (link) {
    const source = graphNode(graph, link.origin_id);
    if (!source || visited.has(source.id) || Number(source.mode) === NODE_MODE_NEVER) break;
    visited.add(source.id);
    if (Number(source.mode) === NODE_MODE_BYPASS) {
      const inputIndex = bypassInputIndex(source, Number(link.origin_slot), "STRING");
      if (inputIndex < 0) break;
      link = graphLink(graph, source.inputs?.[inputIndex]?.link);
      continue;
    }
    const sourceWidget = editableMultilineWidget(source);
    if (sourceWidget) return { status: "connected", node: source, widget: sourceWidget };
    const stringInputs = (source.inputs || []).filter((candidate) => candidate?.type === "STRING" && candidate.link != null);
    const stringOutputs = (source.outputs || []).filter((candidate) => candidate?.type === "STRING");
    if (stringInputs.length !== 1 || stringOutputs.length !== 1) break;
    link = graphLink(graph, stringInputs[0].link);
  }
  return { status: "incompatible_source" };
}

function setWidgetValue(app, node, target, value) {
  const previous = target.value;
  target.value = value;
  if (typeof target.callback === "function") target.callback(value, app?.canvas, node);
  if (typeof node?.onWidgetChanged === "function") node.onWidgetChanged(target.name, value, previous, target);
  node?.graph?.setDirtyCanvas?.(true, true);
  app?.graph?.setDirtyCanvas?.(true, true);
  app?.canvas?.setDirty?.(true, true);
  app?.graph?.change?.();
}

function applyWidgetMutations(app, mutations) {
  const applied = [];
  try {
    for (const mutation of mutations) {
      const previous = mutation.target.value;
      applied.push({ ...mutation, previous });
      setWidgetValue(app, mutation.node, mutation.target, mutation.value);
    }
    return null;
  } catch (error) {
    for (const mutation of applied.reverse()) {
      try {
        setWidgetValue(app, mutation.node, mutation.target, mutation.previous);
      } catch {
        mutation.target.value = mutation.previous;
      }
    }
    return error;
  }
}


export function continuumSamplerSettings(sampler) {
  return {
    prompt_mode: String(widget(sampler, "prompt_mode")?.value ?? ""),
    chunks: Number(widget(sampler, "chunks")?.value),
    chunk_seconds: Number(widget(sampler, "chunk_seconds")?.value),
  };
}

export function applySequenceToContinuum(app, sampler, sequenceState, { syncSettings = false, mode = null } = {}) {
  if (!isCompatibleContinuumSampler(sampler)) return { status: "incompatible_sampler" };
  const settings = normalizeContinuumSettings(sequenceState?.settings || {});
  const preamble = typeof sequenceState?.preamble === "string"
    ? sequenceState.preamble
    : typeof sequenceState?.plan?.global?.sequence_preamble === "string"
      ? sequenceState.plan.global.sequence_preamble
      : "";
  const prompt = serializeContinuumPrompts(sequenceState?.prompts || [], {
    preamble,
    chunkSeconds: settings.chunk_seconds,
  });
  const parsed = parseContinuumTimeline(prompt, {
    expectedChunks: settings.chunks,
    chunkSeconds: settings.chunk_seconds,
  });
  const inventory = discoverContinuumReferenceInventory(app, sampler);
  if (
    sequenceState?.downstream_reference_inventory
    && !sameContinuumWorkflowSourceInventory(sequenceState.downstream_reference_inventory, inventory)
  ) {
    return {
      status: "source_inventory_mismatch",
      saved_inventory: sequenceState.downstream_reference_inventory,
      inventory,
      prompt,
      sampler,
    };
  }
  if (mode) {
    const modeTopology = validateContinuumModeTopology(mode, inventory);
    if (!modeTopology.valid) {
      return {
        status: "mode_topology_mismatch",
        mode_topology: modeTopology,
        inventory,
        prompt,
        sampler,
      };
    }
  }
  const referenceScope = validateContinuumReferenceScope(
    inventory,
    parsed.preamble,
    parsed.prompts,
  );
  if (!referenceScope.valid) {
    return {
      status: "reference_mismatch",
      violations: referenceScope.violations,
      inventory,
      prompt,
      sampler,
    };
  }

  const source = connectedSequenceTextSource(app?.graph, sampler);
  if (source.status !== "connected") return { ...source, sampler, prompt };

  const current = continuumSamplerSettings(sampler);
  const mismatches = [];
  if (current.prompt_mode !== CONTINUUM_PROMPT_MODE) {
    mismatches.push({ field: "prompt_mode", writer: CONTINUUM_PROMPT_MODE, sampler: current.prompt_mode || "(unset)" });
  }
  if (current.chunks !== settings.chunks) mismatches.push({ field: "chunks", writer: settings.chunks, sampler: current.chunks });
  if (current.chunk_seconds !== settings.chunk_seconds) {
    mismatches.push({ field: "chunk_seconds", writer: settings.chunk_seconds, sampler: current.chunk_seconds });
  }
  if (mismatches.length && !syncSettings) return { status: "mismatch", mismatches, sampler };

  const mutations = [];
  if (syncSettings) {
    if (current.prompt_mode !== CONTINUUM_PROMPT_MODE) {
      mutations.push({
        node: sampler,
        target: widget(sampler, "prompt_mode"),
        value: CONTINUUM_PROMPT_MODE,
      });
    }
    if (current.chunks !== settings.chunks) {
      mutations.push({
        node: sampler,
        target: widget(sampler, "chunks"),
        value: settings.chunks,
      });
    }
    if (current.chunk_seconds !== settings.chunk_seconds) {
      mutations.push({
        node: sampler,
        target: widget(sampler, "chunk_seconds"),
        value: settings.chunk_seconds,
      });
    }
  }
  mutations.push({ node: source.node, target: source.widget, value: prompt });

  const applyError = applyWidgetMutations(app, mutations);
  if (applyError) {
    return {
      status: "apply_failed",
      sampler,
      prompt,
      message: applyError instanceof Error ? applyError.message : String(applyError),
    };
  }
  return {
    status: "applied",
    sampler,
    source: source.node,
    prompt,
    settings,
    prompt_mode: CONTINUUM_PROMPT_MODE,
  };
}

export function continuumSamplerLabel(node) {
  const title = String(node?.title || "H3 Continuum Sampler");
  return node?.id == null ? title : `${title} · node ${node.id}`;
}
