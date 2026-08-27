/** Minimal extension registry compatible with the upstream frontend. */
const extensions = [];

export const app = {
  registerExtension(extension) {
    extensions.push(extension);
  },
};

export async function boot() {
  for (const extension of extensions) {
    await extension.setup?.();
  }

  const openCommand = extensions
    .flatMap((extension) => extension.commands || [])
    .find((command) => command.id === "h3-prompt-studio.open");
  if (typeof openCommand?.function !== "function") {
    throw new Error("The upstream H3 Prompt Writer open command was not registered.");
  }

  await openCommand.function();
  document.documentElement.dataset.h3StandaloneReady = "true";
}
