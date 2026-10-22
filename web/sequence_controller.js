import { t } from "./i18n.js";
import { replacePrompt, sequenceInputs } from "./sequence_state.js";

// Only complete, owned responses replace the working text. Progress is ephemeral.
export function createSequenceController({ state, snapshot, prepare, run, cancel, changed = () => {}, busyChanged = () => {}, progressChanged = () => {}, error = () => {}, settled = () => {} }) {
  let active = null, session = 0;
  const progress = new Map();
  let phaseKey = "";
  const current = op => active === op && op.session === session && !op.cancelled;
  const sendCancel = op => Promise.resolve(cancel(op.id)).catch(failure => {
    if (active === op && op.session === session) error(failure);
  });
  return {
    get busy() { return active !== null; },
    get progress() { return progress; },
    get phase() { return phaseKey ? t(phaseKey) : ""; },
    async start(action = "missing", chunkId = null, instruction = "") {
      if (active) return;
      const targets = state.chunks.filter(c => action === "all" || (action === "missing" ? !c.prompt.trim() || c.attention : c.id === chunkId));
      if (!targets.length) return;
      const op = { id: globalThis.crypto.randomUUID(), session, cancelled: false, sent: false };
      let expected, pending, stoppedForAttention = false;
      try {
        const payload = structuredClone({ ...snapshot(), sequence: sequenceInputs(state), action, chunk_id: chunkId, instruction, operation_id: op.id });
        expected = JSON.stringify(sequenceInputs(state));
        pending = new Set(targets.map(c => c.id));
        active = op;
        progress.clear(); phaseKey = "sequence.phase.preparing";
        targets.forEach(c => progress.set(c.id, "queued"));
        busyChanged(true);
        if (!await prepare() || !current(op)) return;
        if (JSON.stringify(sequenceInputs(state)) !== expected) throw new Error(t("sequence.error.changed_prepare"));
        for (const chunk of targets) if (chunk.prompt || chunk.attention) replacePrompt(chunk, "");
        expected = JSON.stringify(sequenceInputs(state));
        changed();
        op.sent = true;
        await run(payload, event => {
          if (active === op && event.operation_id === op.id && event.type === "started" && op.cancelled) sendCancel(op);
          if (!current(op) || event.operation_id !== op.id) return;
          if (event.type === "warning") error(Object.assign(new Error(event.message), { severity: "warning" }));
          if (event.type === "phase") {
            if (pending.has(event.chunk_id)) progress.set(event.chunk_id, event.phase);
            phaseKey = event.phase === "planning" ? "sequence.phase.planning" : "";
            progressChanged();
          }
          if (event.type === "chunk") {
            const chunk = state.chunks.find(c => c.id === event.chunk_id);
            if (!chunk || !pending.has(chunk.id) || typeof event.prompt !== "string" || !event.prompt.trim()) return;
            if (JSON.stringify(sequenceInputs(state)) !== expected) throw new Error(t("sequence.error.changed_generate"));
            chunk.prompt = event.prompt;
            if (event.attention) chunk.attention = event.attention;
            pending.delete(chunk.id);
            progress.delete(chunk.id);
            expected = JSON.stringify(sequenceInputs(state));
            changed();
            if (event.attention) {
              stoppedForAttention = true;
              error(Object.assign(new Error(t("sequence.error.model_review", {
                index: state.chunks.indexOf(chunk) + 1,
                repair: event.repair === "failed" ? t("sequence.error.after_repair") : "",
              })), { severity: "warning" }));
            }
          }
        });
        if (current(op) && pending.size && !stoppedForAttention) throw new Error(t("sequence.error.connection_ended"));
        if (current(op)) settled(stoppedForAttention ? "attention" : "complete");
      } catch (failure) {
        if (!active || current(op)) {
          const id = [...progress].find(([, status]) => ["generating", "checking", "repairing", "failed"].includes(status))?.[0];
          // The backend sends "Chunk N failed: ..." in English. Keep that raw text and
          // only wrap errors that did not already come from a specific chunk.
          if (id && !failure.message.startsWith("Chunk ")) {
            failure.message = t("sequence.error.chunk_failed", {
              index: state.chunks.findIndex(c => c.id === id) + 1,
              message: failure.message,
            });
            progress.set(id, "failed");
          }
          error(failure);
          if (op.sent && failure.code !== "GENERATION_CANCELLED") settled("failed");
          if (active === op && op.sent) await sendCancel(op);
        }
      } finally {
        if (active === op) {
          active = null; phaseKey = "";
          for (const [id, status] of progress) progress.set(id, status === "queued" ? "not_started" : op.cancelled ? "cancelled" : status === "failed" ? "failed" : "stopped");
          busyChanged(false);
        }
      }
    },
    cancel() {
      if (!active) return;
      active.cancelled = true; phaseKey = "sequence.phase.cancelling"; progressChanged();
      if (active.sent) sendCancel(active);
    },
    leave() { session++; this.cancel(); },
  };
}
