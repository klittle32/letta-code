import { getSubagents } from "@/agent/subagent-state";
import type { ModSessionActivationRequest } from "@/mods/session-api";
import { hasUnsettledTuiTurns } from "./tui-turn-owner";

export function getTuiSessionActivationBlocker(
  request: ModSessionActivationRequest,
  activity: {
    commandBlocked: boolean;
    processing: number;
    executing: boolean;
    blockedUi?: boolean;
    approvals: number;
    results: number;
    queued: number;
    turnRef: { current: AbortController | null };
  },
): string | undefined {
  if (activity.blockedUi) return "Host UI work is pending";
  if (activity.commandBlocked) return "Another command is running";
  if (
    activity.processing ||
    activity.executing ||
    hasUnsettledTuiTurns(
      activity.turnRef,
      request.agentId ?? "",
      request.sourceConversationId ?? "",
    ) ||
    hasUnsettledTuiTurns(
      activity.turnRef,
      request.agentId ?? "",
      request.conversationId,
    )
  )
    return "Turn or actual tool execution is not settled";
  if (activity.approvals || activity.results) return "Approval work is pending";
  if (activity.queued) return "Queued input is pending";
  if (
    getSubagents().some(
      (child) =>
        (child.status === "pending" ||
          child.status === "running" ||
          child.cancelPending ||
          child.stopFailed) &&
        (!child.parentAgentId || child.parentAgentId === request.agentId) &&
        (!child.parentConversationId ||
          child.parentConversationId === request.sourceConversationId ||
          child.parentConversationId === request.conversationId),
    )
  )
    return "Scoped child work is not settled";
  return undefined;
}
