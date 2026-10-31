import { ApprovalExecutionSettlement } from "@/agent/approval-execution-settlement";
import {
  createTurnInterruptController,
  type InterruptTurnRef,
} from "@/agent/turn-interrupt";

/** Logical ownership survives individual streaming calls and approval pauses. */
export function createTuiTurnControl(options: {
  turn: InterruptTurnRef;
  isCurrent: () => boolean;
  cancelRun: (runId: string) => Promise<void>;
  hasChildren: () => boolean;
}) {
  const abortController = new AbortController();
  const executionSettlement = new ApprovalExecutionSettlement();
  let active = true;
  let calls = 0;
  let waitingApproval = false;
  let completed = false;
  let backendStarted = false;
  let runId: string | undefined;
  let childrenAtRequest = false;
  let requestedRunId: string | undefined;
  let requestedBackendStarted = false;
  let resolveOwner!: () => void;
  const ownerDone = new Promise<void>((resolve) => {
    resolveOwner = resolve;
  });
  const controller = createTurnInterruptController({
    turn: options.turn,
    isCurrent: () => active && options.isCurrent(),
    abort: (reason) => {
      childrenAtRequest = options.hasChildren();
      requestedRunId = runId;
      requestedBackendStarted = backendStarted;
      executionSettlement.cancel();
      abortController.abort(reason);
      if (calls === 0 && !waitingApproval) resolveOwner();
    },
    settlement: {
      owner: async () => {
        if (waitingApproval && calls === 0)
          throw new Error("Approval pause has not been retired by its host");
        await ownerDone;
      },
      backend: async () => {
        if (!requestedBackendStarted) return;
        // Capture before awaiting; no lookup of a latest run or conversation.
        const exactRunId = requestedRunId;
        if (!exactRunId || !options.turn.agentId)
          throw new Error("Exact backend run cancellation is unavailable");
        await options.cancelRun(exactRunId);
      },
      tools: async () => {
        if (calls > 0) await ownerDone;
        await executionSettlement.waitForSettlement();
        const failed = executionSettlement
          .snapshot()
          .find((entry) => entry.error !== undefined);
        if (failed) throw failed.error;
      },
      children: async () => {
        if (calls > 0) await ownerDone;
        await executionSettlement.waitForSettlement();
        if (childrenAtRequest || options.hasChildren())
          throw new Error(
            "Active child work has no exact turn cancellation ownership",
          );
      },
    },
  });
  return {
    request: controller.request,
    turn: options.turn,
    signal: abortController.signal,
    abortController,
    executionSettlement,
    get active() {
      return active;
    },
    enter() {
      calls++;
      waitingApproval = false;
      completed = false;
    },
    leave(approval: boolean) {
      calls--;
      completed ||= !approval;
      waitingApproval = approval && !completed;
      if (calls === 0 && (!waitingApproval || abortController.signal.aborted)) {
        active = false;
        resolveOwner();
      }
    },
    beginBackend() {
      backendStarted = true;
      runId = undefined;
    },
    observeRun(id: string | undefined) {
      runId = id;
    },
  };
}
