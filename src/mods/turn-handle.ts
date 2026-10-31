import type {
  InterruptTurnRef,
  TurnInterruptController,
} from "@/agent/turn-interrupt";
import type { ModTurnHandle } from "@/mods/types";

const controllers = new WeakMap<ModTurnHandle, TurnInterruptController>();

/** Host handles cannot be used until bound to an invocation's activation. */
export function createHostTurnHandle(
  turn: InterruptTurnRef,
  controller: TurnInterruptController,
): ModTurnHandle {
  const handle: ModTurnHandle = Object.freeze({
    ...turn,
    requestInterrupt: () => ({
      status: "not-applied" as const,
      reason: "inactive-owner" as const,
    }),
  });
  controllers.set(handle, controller);
  return handle;
}

export function bindModTurnHandle(
  handle: ModTurnHandle | undefined,
  signal: AbortSignal | undefined,
): ModTurnHandle | undefined {
  if (!handle || !signal) return undefined;
  const controller = controllers.get(handle);
  if (!controller) return undefined;
  return Object.freeze({
    id: handle.id,
    agentId: handle.agentId,
    conversationId: handle.conversationId,
    requestInterrupt: (reason?: string) => controller.request(signal, reason),
  });
}

/** Preserve invocation traps while capturing the owner-bound turn once. */
export function bindModTurnContext<T extends { turn?: ModTurnHandle }>(
  context: T,
  signal: AbortSignal | undefined,
): T {
  const turn = bindModTurnHandle(context.turn, signal);
  return new Proxy(context, {
    get(target, property, receiver) {
      return property === "turn"
        ? turn
        : Reflect.get(target, property, receiver);
    },
  });
}
