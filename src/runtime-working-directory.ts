import { updateRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";

/** Wait for both settings reads before returning or restoring another scope. */
export async function loadSettingsForWorkingDirectory(
  workingDirectory: string,
): Promise<void> {
  const results = await Promise.allSettled([
    settingsManager.loadProjectSettings(workingDirectory),
    settingsManager.loadLocalProjectSettings(workingDirectory),
  ]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}
export function commitRuntimeWorkingDirectory(workingDirectory: string): void {
  process.chdir(workingDirectory);
  process.env.USER_CWD = workingDirectory;
  updateRuntimeContext({ workingDirectory });
}
export async function switchCurrentRuntimeWorkingDirectory(
  workingDirectory: string,
): Promise<void> {
  await loadSettingsForWorkingDirectory(workingDirectory);
  commitRuntimeWorkingDirectory(workingDirectory);
}
