import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const continuumSource = await readFile(new URL("../web/continuum.js", import.meta.url), "utf8");
const continuumEncoded = Buffer.from(continuumSource).toString("base64");
const {
  bindContinuumReferenceMedia,
  discoverContinuumReferenceInventory,
  discoverContinuumWorkflowImageMedia,
  sameContinuumReferenceInventory,
  sameContinuumWorkflowSourceInventory,
  validateContinuumModeTopology,
} = await import(`data:text/javascript;base64,${continuumEncoded}`);

const OUTPUT_NAMES = [
  "image",
  "mask",
  "path",
  "index",
  "remaining_pending",
  "source_path",
  "ref_image_1",
  "ref_image_2",
  "ref_image_3",
  "ref_image_4",
  "ref_image_5",
  "ref_image_6",
  "ref_image_7",
  "ref_image_8",
  "last_frame",
];

function samplerNode(id = 100) {
  return {
    id,
    type: "H3ContinuumSamplerV34",
    inputs: [
      { name: "sequence_prompt", type: "STRING", link: null },
      { name: "first_frame", type: "IMAGE", link: null },
      { name: "last_frame", type: "IMAGE", link: null },
      ...Array.from({ length: 8 }, (_, index) => ({
        name: `reference_image_${index + 1}`,
        type: "IMAGE",
        link: null,
      })),
      { name: "reference_video_1", type: "IMAGE", link: null },
      { name: "driving_audio", type: "AUDIO", link: null },
    ],
    outputs: [],
    widgets: [
      { name: "prompt_mode", value: "Timeline" },
      { name: "chunks", value: 3 },
      { name: "chunk_seconds", value: 5 },
    ],
  };
}

function conveyorNode({
  id = 10,
  type = "ImageConveyor",
  outputMode = "persistent_refs",
  imagesPerExecution = 1,
  referenceSlots = Array(8).fill(null),
  state = {},
  properties = {},
} = {}) {
  const stateJson = JSON.stringify({
    version: 2,
    items: [],
    dont_consume: false,
    images_per_execution: imagesPerExecution,
    output_mode: outputMode,
    reference_slots: referenceSlots,
    ...state,
  });
  return {
    id,
    type,
    inputs: [],
    outputs: OUTPUT_NAMES.map((name) => ({ name, type: name === "mask" ? "MASK" : name.startsWith("ref_image_") || name === "image" || name === "last_frame" ? "IMAGE" : "*", links: [] })),
    widgets: [{ name: "state_json", value: stateJson }],
    properties: { ...properties },
  };
}

function transformNode(id = 20) {
  return {
    id,
    type: "ImageScaleToTotalPixelsX",
    inputs: [{ name: "image", type: "IMAGE", link: null }],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets: [],
  };
}

function bypassNode(id = 30) {
  return {
    id,
    type: "Reroute",
    mode: 4,
    inputs: [{ name: "input", type: "IMAGE", link: null }],
    outputs: [{ name: "output", type: "IMAGE", links: [] }],
    widgets: [],
  };
}

function graphWith(nodes) {
  let nextLink = 1;
  const links = {};
  const graph = {
    _nodes: nodes,
    links,
    getNodeById(id) { return this._nodes.find((node) => node.id === id) || null; },
  };
  nodes.forEach((node) => { node.graph = graph; });
  return {
    graph,
    connect(source, sourceSlot, target, inputName) {
      const targetSlot = target.inputs.findIndex((input) => input.name === inputName);
      assert.notEqual(targetSlot, -1, `missing input ${inputName}`);
      const linkId = nextLink++;
      links[linkId] = {
        origin_id: source.id,
        origin_slot: sourceSlot,
        target_id: target.id,
        target_slot: targetSlot,
      };
      source.outputs[sourceSlot].links.push(linkId);
      target.inputs[targetSlot].link = linkId;
      return linkId;
    },
    app: { graph, canvas: { selected_nodes: {} } },
  };
}

const ref = (name) => ({
  annotated: `${name}.png [input]`,
  filename: `${name}.png`,
  subfolder: "",
  type: "input",
});

test("persistent Image Conveyor excludes disabled and empty shelf outputs and disabled Main through a transform", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), null, ref("three"), ...Array(5).fill(null)],
    state: {
      reference_output_enabled: Array(8).fill(true),
      main_output_enabled: true,
      last_frame_output_enabled: true,
    },
    properties: {
      image_conveyor_reference_enabled: [true, true, false, true, true, true, true, true],
      image_conveyor_main_enabled: false,
    },
  });
  const transform = transformNode();
  const { app, connect } = graphWith([sampler, conveyor, transform]);

  connect(conveyor, 0, transform, "image");
  connect(transform, 0, sampler, "first_frame");
  connect(conveyor, 6, sampler, "reference_image_1");
  connect(conveyor, 7, sampler, "reference_image_2");
  connect(conveyor, 8, sampler, "reference_image_3");
  connect(conveyor, 14, sampler, "last_frame");

  const inventory = discoverContinuumReferenceInventory(app, sampler);
  assert.deepEqual(
    inventory.items.map((item) => [item.role, item.tag ?? null, item.input_name]),
    [
      ["reference_image", "<Picture 1>", "reference_image_1"],
      ["last_frame", null, "last_frame"],
    ],
  );
  assert.deepEqual(validateContinuumModeTopology("Reference", inventory).actual, {
    first_frame: false,
    last_frame: true,
    reference_images: 1,
  });
});

test("persistent Image Conveyor properties override stale serialized toggle snapshots", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), ...Array(7).fill(null)],
    state: {
      reference_output_enabled: Array(8).fill(true),
      main_output_enabled: true,
      last_frame_output_enabled: true,
    },
    properties: {
      image_conveyor_reference_enabled: [false, true, true, true, true, true, true, true],
      image_conveyor_last_frame_enabled: false,
    },
  });
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 6, sampler, "reference_image_1");
  connect(conveyor, 14, sampler, "last_frame");

  assert.deepEqual(discoverContinuumReferenceInventory(app, sampler).items, []);
});

test("queue-group Image Conveyor exposes only configured group members and ignores persistent toggles", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    type: "SequentialBatchImageLoader",
    outputMode: "queue_group",
    imagesPerExecution: 3,
    state: {
      dont_consume: true,
      reference_output_enabled: Array(8).fill(false),
      main_output_enabled: false,
      last_frame_output_enabled: false,
    },
    properties: {
      image_conveyor_reference_enabled: Array(8).fill(false),
      image_conveyor_main_enabled: false,
      image_conveyor_last_frame_enabled: false,
    },
  });
  const { app, connect } = graphWith([sampler, conveyor]);

  connect(conveyor, 0, sampler, "first_frame");
  connect(conveyor, 6, sampler, "reference_image_1");
  connect(conveyor, 7, sampler, "reference_image_3");
  connect(conveyor, 8, sampler, "reference_image_4");
  connect(conveyor, 14, sampler, "last_frame");

  const inventory = discoverContinuumReferenceInventory(app, sampler);
  assert.deepEqual(
    inventory.items.map((item) => [item.role, item.tag ?? null, item.input_name]),
    [
      ["reference_image", "<Picture 1>", "reference_image_1"],
      ["reference_image", "<Picture 2>", "reference_image_3"],
      ["first_frame", null, "first_frame"],
      ["last_frame", null, "last_frame"],
    ],
  );
  assert.equal(inventory.items.some((item) => item.input_name === "reference_image_4"), false);
});

test("bypassed nodes resolve back to Image Conveyor effective reference state", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [null, ...Array(7).fill(null)],
  });
  const bypass = bypassNode();
  const { app, connect } = graphWith([sampler, conveyor, bypass]);

  connect(conveyor, 6, bypass, "input");
  connect(bypass, 0, sampler, "reference_image_1");

  assert.deepEqual(discoverContinuumReferenceInventory(app, sampler).items, []);
});

test("persistent Reference Shelf replacements change saved source identity without exposing filenames", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("alpha"), ...Array(7).fill(null)],
  });
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 6, sampler, "reference_image_1");

  const first = discoverContinuumReferenceInventory(app, sampler);
  const firstIdentity = first.items[0].source_identity;
  assert.match(firstIdentity, /^image-conveyor-ref-v1:[0-9a-f]{16}$/);
  assert.equal(firstIdentity.includes("alpha"), false);

  const stateWidget = conveyor.widgets.find((entry) => entry.name === "state_json");
  const state = JSON.parse(stateWidget.value);
  state.reference_slots[0] = ref("beta");
  stateWidget.value = JSON.stringify(state);

  const second = discoverContinuumReferenceInventory(app, sampler);
  assert.match(second.items[0].source_identity, /^image-conveyor-ref-v1:[0-9a-f]{16}$/);
  assert.notEqual(second.items[0].source_identity, firstIdentity);
  assert.equal(sameContinuumReferenceInventory(first, second), false);
});

test("queue-group outputs remain intentionally dynamic and do not fingerprint queue members", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    outputMode: "queue_group",
    imagesPerExecution: 3,
  });
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 0, sampler, "first_frame");
  connect(conveyor, 6, sampler, "reference_image_1");
  connect(conveyor, 7, sampler, "reference_image_2");

  const inventory = discoverContinuumReferenceInventory(app, sampler);
  assert.equal(inventory.items.length, 3);
  assert.ok(inventory.items.every((item) => !Object.hasOwn(item, "source_identity")));
});

test("non-Conveyor image sources retain ordinary wire-based discovery", () => {
  const sampler = samplerNode();
  const loader = {
    id: 50,
    type: "LoadImage",
    inputs: [],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets: [],
  };
  const { app, connect } = graphWith([sampler, loader]);
  connect(loader, 0, sampler, "reference_image_4");

  const inventory = discoverContinuumReferenceInventory(app, sampler);
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0].tag, "<Picture 1>");
  assert.equal(inventory.items[0].source_node_class, "LoadImage");
});

test("persistent active Conveyor Reference Shelf slots expose importable Writer media descriptors", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), ...Array(7).fill(null)],
  });
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 6, sampler, "reference_image_3");

  const discovered = discoverContinuumWorkflowImageMedia(app, sampler);
  assert.equal(discovered.candidates.length, 1);
  assert.deepEqual(
    {
      label: discovered.candidates[0].label,
      input_name: discovered.candidates[0].input_name,
      importable: discovered.candidates[0].importable,
      source_kind: discovered.candidates[0].source_kind,
      file: discovered.candidates[0].file,
    },
    {
      label: "<Picture 1>",
      input_name: "reference_image_3",
      importable: true,
      source_kind: "image_conveyor_persistent",
      file: { filename: "one.png", subfolder: "", type: "input" },
    },
  );
});

test("queue-group workflow image slots are visible in the UI contract but cannot be falsely materialized as stable files", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({ outputMode: "queue_group", imagesPerExecution: 2 });
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 6, sampler, "reference_image_1");

  const candidate = discoverContinuumWorkflowImageMedia(app, sampler).candidates[0];
  assert.equal(candidate.label, "<Picture 1>");
  assert.equal(candidate.importable, false);
  assert.equal(candidate.reason, "dynamic_queue_group");
});

test("processed Conveyor reference chains remain active conditioning but refuse an inexact pre-execution media copy", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), ...Array(7).fill(null)],
  });
  const transform = transformNode();
  transform.type = "UnsupportedImageTransform";
  const { app, connect } = graphWith([sampler, conveyor, transform]);
  connect(conveyor, 6, transform, "image");
  connect(transform, 0, sampler, "reference_image_1");

  const candidate = discoverContinuumWorkflowImageMedia(app, sampler).candidates[0];
  assert.equal(candidate.importable, false);
  assert.equal(candidate.reason, "processed_image_chain");
});

test("direct LoadImage workflow references can be imported from their selected ComfyUI input file", () => {
  const sampler = samplerNode();
  const loader = {
    id: 51,
    type: "LoadImage",
    inputs: [],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets: [{ name: "image", value: "characters/alice.png" }],
  };
  const { app, connect } = graphWith([sampler, loader]);
  connect(loader, 0, sampler, "reference_image_1");

  const discovered = discoverContinuumWorkflowImageMedia(app, sampler);
  assert.equal(discovered.candidates[0].importable, true);
  assert.deepEqual(discovered.candidates[0].file, {
    filename: "alice.png",
    subfolder: "characters",
    type: "input",
  });
  assert.match(discovered.inventory.items[0].source_identity, /^load-image-v1:[0-9a-f]{16}$/);
});

test("bound workflow media makes exactly the matching active source visible to the prompt model", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), ...Array(7).fill(null)],
  });
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 6, sampler, "reference_image_1");

  const discovered = discoverContinuumWorkflowImageMedia(app, sampler);
  const candidate = discovered.candidates[0];
  const bindings = {
    [candidate.key]: {
      asset_id: "asset-1",
      source_identity: candidate.source_identity,
    },
  };
  const bound = bindContinuumReferenceMedia(discovered.inventory, bindings, [{ id: "asset-1" }]);
  assert.equal(bound.items[0].visible_to_model, true);
  assert.equal(bound.items[0].model_asset_id, "asset-1");

  bindings[candidate.key].source_identity = "image-conveyor-ref-v1:ffffffffffffffff";
  const stale = bindContinuumReferenceMedia(discovered.inventory, bindings, [{ id: "asset-1" }]);
  assert.equal(stale.items[0].visible_to_model, false);
  assert.equal(Object.hasOwn(stale.items[0], "model_asset_id"), false);
});

test("Apply-to-Continuum source comparison ignores Prompt Writer media binding while preserving workflow source drift", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), ...Array(7).fill(null)],
  });
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 6, sampler, "reference_image_1");

  const active = discoverContinuumReferenceInventory(app, sampler);
  const saved = structuredClone(active);
  saved.items[0].visible_to_model = true;
  saved.items[0].model_asset_id = "asset-1";

  assert.equal(sameContinuumReferenceInventory(saved, active), false);
  assert.equal(sameContinuumWorkflowSourceInventory(saved, active), true);

  const changed = structuredClone(active);
  changed.items[0].source_identity = "image-conveyor-ref-v1:ffffffffffffffff";
  assert.equal(sameContinuumWorkflowSourceInventory(saved, changed), false);
});

test("reviewed Scale Image to Total Pixels Adv chain is materializable and transform-aware", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), ...Array(7).fill(null)],
  });
  const scale = {
    id: 60,
    type: "ImageScaleToTotalPixelsX",
    inputs: [
      { name: "image", type: "IMAGE", link: null },
      { name: "width", type: "INT", link: null },
      { name: "height", type: "INT", link: null },
    ],
    outputs: [
      { name: "image", type: "IMAGE", links: [] },
      { name: "width", type: "INT", links: [] },
      { name: "height", type: "INT", links: [] },
    ],
    widgets: [
      { name: "megapixels", value: 0.70 },
      { name: "multiple_of", value: 32 },
      { name: "resize_mode", value: "crop" },
      { name: "upscale_method", value: "lanczos" },
    ],
  };
  const { app, connect } = graphWith([sampler, conveyor, scale]);
  connect(conveyor, 6, scale, "image");
  connect(scale, 0, sampler, "reference_image_1");

  const discovered = discoverContinuumWorkflowImageMedia(app, sampler);
  const candidate = discovered.candidates[0];
  assert.equal(candidate.importable, true);
  assert.equal(candidate.source_kind, "scale_image_to_total_pixels_x");
  assert.equal(candidate.materialization_plan.contract_sha, "79e831097bb7a76ade3a28359300e62332086c42");
  assert.deepEqual(candidate.materialization_plan, {
    kind: "image_scale_to_total_pixels_x",
    version: 1,
    node_class: "ImageScaleToTotalPixelsX",
    contract_sha: "79e831097bb7a76ade3a28359300e62332086c42",
    megapixels: 0.70,
    multiple_of: 32,
    resize_mode: "crop",
    upscale_method: "lanczos",
  });
  assert.match(candidate.source_identity, /^workflow-materialized-v1:[0-9a-f]{16}$/);
  assert.equal(discovered.inventory.items[0].source_identity, candidate.source_identity);

  const before = candidate.source_identity;
  scale.widgets.find((entry) => entry.name === "megapixels").value = 0.80;
  const after = discoverContinuumWorkflowImageMedia(app, sampler).candidates[0].source_identity;
  assert.notEqual(after, before);
});

test("Scale Image to Total Pixels Adv fails closed for dynamic overrides and unreviewed resize methods", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode({
    referenceSlots: [ref("one"), ...Array(7).fill(null)],
  });
  const scale = {
    id: 61,
    type: "ImageScaleToTotalPixelsX",
    inputs: [
      { name: "image", type: "IMAGE", link: null },
      { name: "width", type: "INT", link: 999 },
      { name: "height", type: "INT", link: null },
    ],
    outputs: [{ name: "image", type: "IMAGE", links: [] }],
    widgets: [
      { name: "megapixels", value: 0.70 },
      { name: "multiple_of", value: 32 },
      { name: "resize_mode", value: "crop" },
      { name: "upscale_method", value: "lanczos" },
    ],
  };
  const { app, connect } = graphWith([sampler, conveyor, scale]);
  connect(conveyor, 6, scale, "image");
  connect(scale, 0, sampler, "reference_image_1");

  let candidate = discoverContinuumWorkflowImageMedia(app, sampler).candidates[0];
  assert.equal(candidate.importable, false);
  assert.equal(candidate.reason, "dynamic_transform_parameters");

  scale.inputs.find((entry) => entry.name === "width").link = null;
  scale.inputs.push({ name: "megapixels", type: "FLOAT", link: 1001 });
  candidate = discoverContinuumWorkflowImageMedia(app, sampler).candidates[0];
  assert.equal(candidate.importable, false);
  assert.equal(candidate.reason, "dynamic_transform_parameters");

  scale.inputs.find((entry) => entry.name === "megapixels").link = null;
  scale.widgets.find((entry) => entry.name === "upscale_method").value = "bicubic";
  candidate = discoverContinuumWorkflowImageMedia(app, sampler).candidates[0];
  assert.equal(candidate.importable, false);
  assert.equal(candidate.reason, "unsupported_transform_method");
});

test("unreadable Image Conveyor state fails closed instead of inventing public identities", () => {
  const sampler = samplerNode();
  const conveyor = conveyorNode();
  conveyor.widgets[0].value = "{broken";
  delete conveyor.__bil;
  const { app, connect } = graphWith([sampler, conveyor]);
  connect(conveyor, 6, sampler, "reference_image_1");

  assert.throws(
    () => discoverContinuumReferenceInventory(app, sampler),
    /no readable state_json/,
  );
});
