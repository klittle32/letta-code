import type {
  ModCommand,
  ModCommandRegistration,
  ModOwner,
} from "@/mods/types";

export function validateModCommandId(id: string): void {
  if (id.startsWith("/")) {
    throw new Error("Mod command id must not start with '/'");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      "Mod command id must be a lowercase slug using letters, numbers, and hyphens",
    );
  }
}

export function normalizeModCommand(
  command: ModCommandRegistration,
  owner: ModOwner,
): ModCommand {
  validateModCommandId(command.id);
  if (!command.description.trim()) {
    throw new Error(`Mod command '${command.id}' must include a description`);
  }
  if (typeof command.run !== "function") {
    throw new Error(`Mod command '${command.id}' must include run()`);
  }

  return {
    id: command.id,
    description: command.description,
    ...(command.args ? { args: command.args } : {}),
    owner,
    order: command.order ?? 250,
    path: owner.path,
    runWhenBusy: command.runWhenBusy === true,
    showInTranscript: command.showInTranscript !== false,
    run: command.run,
  };
}
