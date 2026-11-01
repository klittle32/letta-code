import { ApprovalExecutionSettlement } from "@/agent/approval-execution-settlement";
import {
  createTurnInterruptController,
  type InterruptTurnRef,
} from "@/agent/turn-interrupt";
import { createTuiChildSettlement } from "./tui-child-settlement";

/** Logical ownership survives individual streaming calls and approval pauses. */
export function createTuiTurnControl(options: {
  turn: InterruptTurnRef;
  isCurrent: () => boolean;
  cancelRun: (runId: string) => Promise<void>;
  children?: (execution: ApprovalExecutionSettlement) => {
    cancel(): void;
    wait(): Promise<void>;
  };
}) {
  const abortController = new AbortController();
  const executionSettlement = new ApprovalExecutionSettlement();
  let active = true;
  let calls = 0;
  let waitingApproval = false;
  let approvalIds = new Set<string>();
  let preserveApproval: (() => void) | undefined;
  let approvalRetired = false;
  let terminalHandler:
    | ((
        reason: string,
        assistantMessage?: string,
      ) => Promise<string | undefined>)
    | undefined;
  let terminalReason: string | undefined;
  let terminalPromise: Promise<string | undefined> | undefined;
  let finalization: Promise<void> | undefined;
  const pausedAbortListeners = new Set<() => void>();
  const notifyPausedAbort = () => {
    if (waitingApproval && calls === 0 && abortController.signal.aborted) {
      for (const listener of pausedAbortListeners) listener();
      retireApprovalPause(() => {});
    }
  };
  const end = async (
    reason: string,
    assistantMessage?: string,
  ): Promise<string | undefined> => {
    terminalReason ??= abortController.signal.aborted ? "cancelled" : reason;
    terminalPromise ??= Promise.resolve()
      .then(() => terminalHandler?.(terminalReason as string, assistantMessage))
      .catch(() => undefined);
    const continuation = await terminalPromise;
    return terminalReason !== "cancelled" &&
      terminalReason !== "error" &&
      !abortController.signal.aborted &&
      typeof continuation === "string"
      ? continuation
      : undefined;
  };
  const finalize = (reason = "error"): Promise<void> => {
    finalization ??= (async () => {
      await end(reason);
      active = false;
      resolveOwner();
    })();
    return finalization;
  };
  const retireApprovalPause = (retire: () => void) => {
    if (calls !== 0 || !waitingApproval || !abortController.signal.aborted)
      return false;
    waitingApproval = false;
    approvalRetired = true;
    preserveApproval?.();
    retire();
    void finalize();
    return true;
  };
  abortController.signal.addEventListener("abort", notifyPausedAbort);
  let backendStarted = false;
  let runId: string | undefined;
  const children =
    options.children?.(executionSettlement) ??
    createTuiChildSettlement(options.turn, executionSettlement);
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
      requestedRunId = runId;
      requestedBackendStarted = backendStarted;
      executionSettlement.cancel();
      children.cancel();
      abortController.abort(reason);
      if (calls === 0 && !waitingApproval) void finalize();
    },
    settlement: {
      owner: async () => {
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
      children: () => children.wait(),
    },
  });
  return {
    request: controller.request,
    turn: options.turn,
    signal: abortController.signal,
    abortController,
    executionSettlement,
    async whenQuiescent() {
      await ownerDone;
      await executionSettlement.waitForSettlement();
    },
    get active() {
      return active;
    },
    enter() {
      calls++;
      waitingApproval = false;
      approvalIds.clear();
      preserveApproval = undefined;
      approvalRetired = false;
    },
    async leave(approval: boolean, reason = "error") {
      calls--;
      waitingApproval ||= approval;
      if (calls === 0 && !waitingApproval) await finalize(reason);
      else notifyPausedAbort();
    },
    expectApprovalPause(ids: string[], preserve?: () => void) {
      approvalIds = new Set(ids);
      preserveApproval = preserve;
    },
    get approvalRetired() {
      return approvalRetired;
    },
    ownsApprovalPause(ids: string[]) {
      return (
        ids.length === approvalIds.size &&
        ids.every((id) => approvalIds.has(id))
      );
    },
    setTerminalHandler(handler: NonNullable<typeof terminalHandler>) {
      terminalHandler ??= handler;
    },
    end,
    onPausedAbort(listener: () => void) {
      pausedAbortListeners.add(listener);
      if (approvalRetired) listener();
      else notifyPausedAbort();
      return () => {
        pausedAbortListeners.delete(listener);
      };
    },
    retireApprovalPause,
    beginBackend() {
      backendStarted = true;
      runId = undefined;
    },
    get observedRunId() {
      return runId;
    },
    observeRun(id: string | undefined) {
      runId = id;
    },
  };
}
