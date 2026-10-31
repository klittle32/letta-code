import type { ApprovalExecutionSettlement } from "@/agent/approval-execution-settlement";
import {
  getSubagents,
  interruptSubagentById,
  type SubagentState,
  subscribe,
} from "@/agent/subagent-state";
import type { InterruptTurnRef } from "@/agent/turn-interrupt";

/** A turn may stop only foreground children correlated to its unsettled tickets. */
export function createTuiChildSettlement(
  turn: InterruptTurnRef,
  execution: ApprovalExecutionSettlement,
) {
  const tickets = new Set<string>();
  const tracked = new Map<
    string,
    { requested: boolean; settled: boolean; error?: string }
  >();
  let toolsDone = false;
  let started = false;
  let scanning = false;
  let rescan = false;
  let unsubscribe: (() => void) | undefined;
  let finish!: (errors: string[]) => void;
  const completion = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const relevant = (child: SubagentState) =>
    !child.isBackground &&
    (child.parentAgentId === undefined ||
      child.parentAgentId === turn.agentId) &&
    (child.parentConversationId === undefined ||
      child.parentConversationId === turn.conversationId) &&
    (!child.toolCallId || tickets.has(child.toolCallId));
  const scan = () => {
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = true;
    do {
      rescan = false;
      const rows = getSubagents();
      for (const child of rows) {
        if (!relevant(child)) continue;
        const live =
          child.status === "pending" ||
          child.status === "running" ||
          child.cancelPending ||
          child.stopFailed;
        let record = tracked.get(child.id);
        if (!record && !live) continue;
        if (!record) {
          record = { requested: false, settled: false };
          tracked.set(child.id, record);
        }
        if (
          !child.toolCallId ||
          child.parentAgentId !== turn.agentId ||
          child.parentConversationId !== turn.conversationId
        ) {
          record.error = `Child ${child.id} has incomplete turn ownership`;
          continue;
        }
        if (child.stopFailed) {
          record.error = `Child ${child.id} stop failed`;
          continue;
        }
        if (!record.requested && live && !child.cancelPending) {
          record.requested = true;
          const result = interruptSubagentById(
            child.id,
            "Parent turn interrupted",
          );
          if (result === "unavailable") {
            record.requested = false;
            if (toolsDone) record.error = `Child ${child.id} has no stop hook`;
          }
        }
        // Re-read: the hook may have settled synchronously.
        const current = getSubagents().find((row) => row.id === child.id);
        if (current?.stopFailed) record.error = `Child ${child.id} stop failed`;
        else if (
          current &&
          !current.cancelPending &&
          current.status !== "pending" &&
          current.status !== "running"
        )
          record.settled = true;
      }
      if (toolsDone) {
        for (const [id, record] of tracked)
          if (
            !record.settled &&
            !record.error &&
            !rows.some((row) => row.id === id)
          )
            record.error = `Child ${id} disappeared before stop settlement`;
        if (
          [...tracked.values()].every(
            (record) => record.settled || record.error,
          )
        ) {
          unsubscribe?.();
          unsubscribe = undefined;
          finish(
            [...tracked.values()].flatMap((record) =>
              record.error ? [record.error] : [],
            ),
          );
        }
      }
    } while (rescan);
    scanning = false;
  };
  return {
    cancel() {
      if (started) return;
      started = true;
      for (const ticket of execution.snapshot())
        if (ticket.state !== "settled") tickets.add(ticket.toolCallId);
      unsubscribe = subscribe(scan);
      scan();
      void execution.waitForSettlement().then(() => {
        toolsDone = true;
        scan();
      });
    },
    async wait() {
      const errors = await completion;
      if (errors.length) throw new Error(errors.join("; "));
    },
  };
}
