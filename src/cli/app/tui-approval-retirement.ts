import { type MutableRefObject, useEffect } from "react";
import type {
  ApprovalDecision,
  buildCompanionResults,
} from "@/agent/approval-execution";
import { type Buffers, onChunk } from "@/cli/helpers/accumulator";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ApprovalContext } from "@/permissions/analyzer";
import {
  buildRetiredApprovalResults,
  preserveTuiApprovalRecovery,
} from "./tui-approval-recovery";
import { getTuiTurnControl } from "./tui-turn-owner";
import type { QueueApprovalResults } from "./types";

type Control = NonNullable<ReturnType<typeof getTuiTurnControl>>;

export function bindApprovalRetirement(
  control: Control,
  isCurrent: () => boolean,
  retire: () => void,
): () => void {
  return control.onPausedAbort(() => {
    control.retireApprovalPause(() => {});
    if (isCurrent()) retire();
  });
}

export function useTuiApprovalRetirement(ctx: {
  abortControllerRef: MutableRefObject<AbortController | null>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string>;
  agentId: string;
  pendingApprovals: ApprovalRequest[];
  approvalResults: ApprovalDecision[];
  autoHandledResults: Parameters<typeof buildCompanionResults>[0];
  autoDeniedApprovals: Parameters<typeof buildCompanionResults>[1];
  queueApprovalResults: QueueApprovalResults;
  buffersRef: MutableRefObject<Buffers>;
  refreshDerived: () => void;
  clearApprovalToolContext: () => void;
  setPendingApprovals: (value: ApprovalRequest[]) => void;
  setApprovalContexts: (value: ApprovalContext[]) => void;
  setApprovalResults: (value: ApprovalDecision[]) => void;
  setAutoHandledResults: (
    value: Parameters<typeof buildCompanionResults>[0],
  ) => void;
  setAutoDeniedApprovals: (
    value: Parameters<typeof buildCompanionResults>[1],
  ) => void;
  setStreaming: (value: boolean) => void;
}) {
  const control = getTuiTurnControl(ctx.abortControllerRef);
  const generation = ctx.conversationGenerationRef.current;
  useEffect(() => {
    if (!control || ctx.pendingApprovals.length === 0) return;
    return bindApprovalRetirement(
      control,
      () =>
        getTuiTurnControl(ctx.abortControllerRef) === control &&
        ctx.conversationGenerationRef.current === generation &&
        ctx.agentId === control.turn.agentId &&
        ctx.conversationIdRef.current === control.turn.conversationId &&
        control.ownsApprovalPause(
          ctx.pendingApprovals.map((approval) => approval.toolCallId),
        ),
      () => {
        const results = buildRetiredApprovalResults(
          ctx.pendingApprovals,
          ctx.approvalResults,
          ctx.autoHandledResults,
          ctx.autoDeniedApprovals,
        );
        preserveTuiApprovalRecovery(
          ctx.abortControllerRef,
          control.turn,
          results,
        );
        ctx.queueApprovalResults(results, {
          conversationId: control.turn.conversationId,
          generation,
        });
        for (const result of results)
          if (result.type === "approval" && !result.approve)
            onChunk(ctx.buffersRef.current, {
              message_type: "tool_return_message",
              id: "interrupt-approval",
              date: new Date().toISOString(),
              tool_call_id: result.tool_call_id,
              tool_return: result.reason ?? "Turn interrupted",
              status: "error",
            });
        ctx.setPendingApprovals([]);
        ctx.setApprovalContexts([]);
        ctx.setApprovalResults([]);
        ctx.setAutoHandledResults([]);
        ctx.setAutoDeniedApprovals([]);
        ctx.clearApprovalToolContext();
        ctx.setStreaming(false);
        ctx.refreshDerived();
      },
    );
  }, [control, ctx, generation]);
}
