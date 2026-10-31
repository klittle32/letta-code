import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type ApprovalDecision,
  type ApprovalResult,
  buildCompanionResults,
} from "@/agent/approval-execution";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import type { InterruptTurnRef } from "@/agent/turn-interrupt";
import { getBackend } from "@/backend";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { analyzeToolApproval } from "@/tools/manager";
import type { createTuiTurnControl } from "./tui-turn-control";

export function buildRetiredApprovalResults(
  pending: ApprovalRequest[],
  decisions: ApprovalDecision[],
  handled: Parameters<typeof buildCompanionResults>[0],
  denied: Parameters<typeof buildCompanionResults>[1],
): ApprovalResult[] {
  const decided = new Map(
    decisions.map((decision) => [decision.approval.toolCallId, decision]),
  );
  return [
    ...buildCompanionResults(handled, denied),
    ...pending.map((approval): ApprovalResult => {
      const decision = decided.get(approval.toolCallId);
      if (decision?.type === "approve" && decision.precomputedResult)
        return {
          type: "tool",
          tool_call_id: approval.toolCallId,
          tool_return: decision.precomputedResult.toolReturn,
          status: decision.precomputedResult.status,
          stdout: decision.precomputedResult.stdout,
          stderr: decision.precomputedResult.stderr,
        };
      return {
        type: "approval",
        tool_call_id: approval.toolCallId,
        approve: false,
        reason:
          decision?.type === "deny"
            ? decision.reason
            : "Turn interrupted before approval execution",
      };
    }),
  ];
}

// Host-lifetime recovery only. Never write an old scope into the active UI queue.
const recoveries = new WeakMap<object, Map<string, ApprovalResult[]>>();
function key(turn: Pick<InterruptTurnRef, "agentId" | "conversationId">) {
  return JSON.stringify([turn.agentId, turn.conversationId]);
}
export function preserveTuiApprovalRecovery(
  owner: object,
  turn: InterruptTurnRef,
  results: ApprovalResult[],
): void {
  let scopes = recoveries.get(owner);
  if (!scopes) {
    scopes = new Map();
    recoveries.set(owner, scopes);
  }
  const previous = scopes.get(key(turn)) ?? [];
  const merged = new Map(
    previous.map((result) => [result.tool_call_id, result]),
  );
  for (const result of results) merged.set(result.tool_call_id, result);
  scopes.set(key(turn), [...merged.values()]);
}
export function admitTuiApprovalPause(
  control: ReturnType<typeof createTuiTurnControl>,
  owner: object,
  pending: ApprovalRequest[],
  handled: Parameters<typeof buildCompanionResults>[0] = [],
  denied: Parameters<typeof buildCompanionResults>[1] = [],
): void {
  const results = buildRetiredApprovalResults(pending, [], handled, denied);
  control.expectApprovalPause(
    pending.map((approval) => approval.toolCallId),
    () => preserveTuiApprovalRecovery(owner, control.turn, results),
  );
}

/** Revalidate across generations; never replay into a replacement conversation. */
export async function recoverTuiApprovalInput(
  owner: object,
  turn: InterruptTurnRef,
  input: Array<MessageCreate | ApprovalCreate>,
  isCurrent: () => boolean,
  pendingIds = async (): Promise<string[] | undefined> => {
    if (!turn.agentId) return [];
    const agent = await getBackend().retrieveAgent(turn.agentId);
    const data = await getResumeDataFromBackend(agent, turn.conversationId);
    // The resume helper reports an empty history on lookup failure. That is
    // not evidence that this previously observed approval batch was resolved.
    if (!data.pendingApprovals?.length && !data.messageHistory.length)
      return undefined;
    return (data.pendingApprovals ?? []).map((approval) => approval.toolCallId);
  },
): Promise<Array<MessageCreate | ApprovalCreate>> {
  const scopes = recoveries.get(owner);
  const saved = scopes?.get(key(turn));
  if (!saved?.length) return input;

  const verifiedIds = await pendingIds();
  if (!verifiedIds || !isCurrent()) return input;
  const pending = new Set(verifiedIds);
  const matched = new Map(
    saved
      .filter((result) => pending.has(result.tool_call_id))
      .map((result) => [result.tool_call_id, result]),
  );
  const overlaid = input.map((item) =>
    item.type === "approval" && item.approvals != null
      ? {
          ...item,
          approvals: item.approvals.map((result) => {
            const replacement = matched.get(result.tool_call_id);
            matched.delete(result.tool_call_id);
            return replacement ?? result;
          }),
        }
      : item,
  );
  // Keep matched results until a later authoritative read confirms resolution:
  // cancellation or a failed dispatch after this function must not lose them.
  const unresolved = saved.filter((result) => pending.has(result.tool_call_id));
  if (unresolved.length) scopes?.set(key(turn), unresolved);
  else scopes?.delete(key(turn));
  return matched.size
    ? [{ type: "approval", approvals: [...matched.values()] }, ...overlaid]
    : overlaid;
}

/** Recovered approval rows may lack valid arguments; keep the basic dialog usable. */
export async function getRecoveredApprovalContexts(
  approvals: ApprovalRequest[],
) {
  try {
    return await Promise.all(
      approvals.map((approval) =>
        analyzeToolApproval(
          approval.toolName,
          safeJsonParseOr<Record<string, unknown>>(approval.toolArgs, {}),
        ),
      ),
    );
  } catch {
    return [];
  }
}
