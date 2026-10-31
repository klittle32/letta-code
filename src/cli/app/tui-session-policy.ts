import {
  type CrossAgentGuardOptions,
  evaluateCrossAgentGuard,
} from "@/permissions/cross-agent-guard";
import { evaluateWorkspaceSandboxGuard } from "@/permissions/workspace-sandbox";
import type { RuntimeWorkspaceSandbox } from "@/runtime-context";

export function assertTuiActivationDirectoryAllowed(
  path: string,
  source: { agentId: string; workingDirectory: string },
  sandbox?: RuntimeWorkspaceSandbox,
  options: CrossAgentGuardOptions = {},
): void {
  const args = { path };
  const denied =
    evaluateWorkspaceSandboxGuard(
      // Trusting a new workspace requires write-strength containment, without
      // changing the ordinary SetWorkingDirectory tool policy.
      "Write",
      { file_path: path },
      source.workingDirectory,
      sandbox,
    ) ??
    evaluateCrossAgentGuard(
      "SetWorkingDirectory",
      args,
      source.workingDirectory,
      { ...options, currentAgentId: source.agentId },
    );
  if (denied) throw new Error(denied.reason);
}
