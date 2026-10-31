import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { getSubagents } from "@/agent/subagent-state";
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
      let cancelError: unknown;
      try {
        await backend.cancelRun(options.agentId, runId);
      } catch (error) {
        // An already-terminal run may reject cancellation. Exact recorded
        // evidence can still establish that no active run remains to cancel.
        cancelError = error;
      }
      const run = await backend.retrieveRun(runId);
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
    hasChildren: () =>
      getSubagents().some(
        (child) =>
          (child.status === "pending" || child.status === "running") &&
          (child.parentAgentId === undefined ||
            child.parentAgentId === options.agentId) &&
          (child.parentConversationId === undefined ||
            child.parentConversationId === options.conversationId),
      ),
  });
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
