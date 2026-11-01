import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  assertTurnReplayAllowed,
  getTurnMessageTransport,
} from "@/agent/message-transport-owner";
import { getBackend } from "@/backend";
import { createHostTurnHandle } from "@/mods/turn-handle";
import type { ModContext } from "@/mods/types";
import { createTuiTurnControl } from "./tui-turn-control";

type ControllerRef = { current: AbortController | null };
type Control = ReturnType<typeof createTuiTurnControl>;
const owners = new WeakMap<
  ControllerRef,
  {
    control: Control;
    generation: number;
    handle: NonNullable<ModContext["turn"]>;
  }
>();

const unsettled = new WeakMap<ControllerRef, Set<Control>>();
export function hasUnsettledTuiTurns(
  ref: ControllerRef,
  agentId: string,
  conversationId: string,
): boolean {
  return [...(unsettled.get(ref) ?? [])].some(
    (control) =>
      control.turn.agentId === agentId &&
      control.turn.conversationId === conversationId &&
      (control.active ||
        control.executionSettlement.pendingToolCallIds().length > 0),
  );
}

export function getTuiTurnControl(ref: ControllerRef): Control | undefined {
  return owners.get(ref)?.control;
}

export function attachTuiTurnContext(
  context: ModContext,
  ref: ControllerRef,
): void {
  Object.defineProperty(context, "turn", {
    enumerable: true,
    get() {
      const owner = owners.get(ref);
      return owner?.control.active ? owner.handle : undefined;
    },
  });
}

export function enterTuiLogicalTurn(options: {
  ref: ControllerRef;
  generationRef: { current: number };
  generation: number;
  continuation: boolean;
  agentId: string;
  conversationId: string;
}): Control {
  const previous = owners.get(options.ref);
  if (
    options.continuation &&
    previous &&
    (previous.control.active || previous.control.signal.aborted) &&
    previous.generation === options.generation &&
    previous.control.turn.conversationId === options.conversationId &&
    previous.control.turn.agentId === options.agentId
  ) {
    previous.control.enter();
    options.ref.current = previous.control.abortController;
    return previous.control;
  }
  const backend = getBackend();
  const control = createTuiTurnControl({
    turn: {
      id: randomUUID(),
      agentId: options.agentId,
      conversationId: options.conversationId,
    },
    isCurrent: () =>
      owners.get(options.ref)?.control === control &&
      options.generationRef.current === options.generation,
    cancelRun: async (runId) => {
      const capturedBackend =
        getTurnMessageTransport(control.signal) ?? backend;
      let cancelError: unknown;
      try {
        await capturedBackend.cancelRun(options.agentId, runId);
      } catch (error) {
        // An already-terminal run may reject cancellation. Exact recorded
        // evidence can still establish that no active run remains to cancel.
        cancelError = error;
      }
      const run = await capturedBackend.retrieveRun(runId);
      if (run.id !== runId || run.agent_id !== options.agentId)
        throw new Error("Backend returned a different run or agent");
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled"
      )
        return;
      if (cancelError !== undefined) throw cancelError;
      // A cancellation ACK cannot override a still-running/unknown record.
      // This certifies host-observable settlement, not remote compute/billing.
      throw new Error(
        "Exact backend run is not observed terminal after cancellation",
        { cause: cancelError },
      );
    },
  });
  let pending = unsettled.get(options.ref);
  if (!pending) {
    pending = new Set();
    unsettled.set(options.ref, pending);
  }
  pending.add(control);
  const owned = pending;
  void control.whenQuiescent().then(() => owned.delete(control));
  owners.set(options.ref, {
    control,
    generation: options.generation,
    handle: createHostTurnHandle(control.turn, control),
  });
  options.ref.current = control.abortController;
  control.enter();
  return control;
}

export function snapshotTuiModContext(
  context: ModContext | undefined,
): ModContext | undefined {
  return context ? { ...context } : undefined;
}

/** Saved approval results accompanying fresh user input belong to the new turn. */
export function isTuiApprovalContinuation(
  input: readonly (MessageCreate | ApprovalCreate)[],
): boolean {
  return (
    input.some((item) => item.type === "approval") &&
    !input.some(
      (item) =>
        item.type !== "approval" && "role" in item && item.role === "user",
    )
  );
}

/** Legacy conversation cancellation must never retarget a principal-bound send. */
export async function cancelTuiBackendConversation(
  ref: ControllerRef,
  target: string,
): Promise<void> {
  const control = owners.get(ref)?.control;
  const captured = control
    ? getTurnMessageTransport(control.signal)
    : undefined;
  if (!captured) {
    await getBackend().cancelConversation(target);
    return;
  }
  const runId = control?.observedRunId;
  if (!runId || !control?.turn.agentId)
    throw new Error(
      "Captured turn has no proven run identity; conversation-wide cancellation is unavailable",
    );
  await captured.cancelRun(control.turn.agentId, runId);
}

export function assertTuiAutomaticRetry(ref: ControllerRef): void {
  const control = owners.get(ref)?.control;
  if (control) assertTurnReplayAllowed(control.signal);
}
