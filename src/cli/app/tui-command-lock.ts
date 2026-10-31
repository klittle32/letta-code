import { useState } from "react";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

export function createTuiCommandLock(publish: (busy: boolean) => void) {
  let command = false;
  let activation = false;
  let invocation: AbortSignal | undefined;
  let activationSource: { agentId: string; conversationId: string } | undefined;
  const parkedMessages: QueuedMessage[] = [];
  const ref = { current: false };
  const update = () => {
    ref.current = command || activation;
    publish(ref.current);
  };
  return {
    ref,
    get parkedMessages(): readonly QueuedMessage[] {
      return parkedMessages;
    },
    parkIncoming(message: QueuedMessage): QueuedMessage | undefined {
      if (!activation || !activationSource) return;
      const parked = structuredClone({
        ...message,
        ...(message.agentId === undefined &&
        message.conversationId === undefined
          ? activationSource
          : {}),
      });
      parkedMessages.push(parked);
      return parked;
    },
    get activationBusy() {
      return activation;
    },
    setCommand(value: boolean) {
      command = value;
      update();
    },
    setActivation(
      value: boolean,
      source?: { agentId: string; conversationId: string },
    ) {
      if (value && !activation) activationSource = source;
      activation = value;
      update();
    },
    commandBlocks(signal: AbortSignal | undefined) {
      return command && (!signal || signal !== invocation);
    },
    enterInvocation(signal: AbortSignal) {
      invocation = signal;
      return () => {
        if (invocation === signal) invocation = undefined;
      };
    },
  };
}
export function useTuiCommandLock() {
  const [busy, setBusy] = useState(false);
  const [lock] = useState(() => createTuiCommandLock(setBusy));
  return [busy, lock.setCommand, lock.ref, lock] as const;
}
