import "/main.js";
import { boot } from "/scripts/app.js";
import { startHostLabels } from "/scripts/host_labels.js";
import { startManagedGGUF } from "/scripts/managed_gguf.js";
import { startStandaloneShell } from "/scripts/standalone_shell.js";

try {
  await boot();
  startHostLabels();
  startManagedGGUF();
  startStandaloneShell();
  document.title = "H3 Prompt Writer";
  document.querySelector("[data-host-status]")?.replaceChildren("Writer is ready.");
} catch (error) {
  document.querySelector("[data-host-status]")?.replaceChildren(
    `Startup failed: ${error?.message || error}`,
  );
  throw error;
}
