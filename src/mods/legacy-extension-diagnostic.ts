import path from "node:path";
import {
  type ModDiagnosticCollector,
  recordModDiagnostic,
} from "./mod-diagnostics";
import type { LocalModSource } from "./mod-sources";
import { getGlobalModsDirectory } from "./paths";
import type { ModDiagnostic, ModOwner } from "./types";

function getLegacyExtensionMigrationTarget(
  source: LocalModSource,
  modPath: string,
): string {
  const targetRoot =
    source.legacyMigrationTargetRoot ?? getGlobalModsDirectory();
  const relativePath = path.relative(source.root, modPath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return path.join(targetRoot, path.basename(modPath));
  }
  return path.join(targetRoot, relativePath);
}

export function recordLegacyExtensionLoadedDiagnostic(
  registry: ModDiagnosticCollector,
  owner: ModOwner,
  source: LocalModSource,
  onDiagnostic: ((diagnostic: ModDiagnostic) => void) | undefined,
): void {
  const error = new Error(
    `Loaded legacy extension from ${owner.path}. Move it to ${getLegacyExtensionMigrationTarget(source, owner.path)}.`,
  );
  error.name = "LegacyExtensionLoaded";
  error.stack = undefined;
  recordModDiagnostic(
    registry,
    {
      error,
      owner,
      phase: "legacy_extension",
      severity: "warning",
    },
    onDiagnostic,
  );
}
