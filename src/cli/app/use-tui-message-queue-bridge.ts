import { useEffect } from "react";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { setMessageQueueAdder } from "@/utils/message-queue-bridge";
import type { createTuiCommandLock } from "./tui-command-lock";

/** Activation arrivals are retained outside the send queue; never retarget them. */
export function useTuiMessageQueueBridge(
  queue: { current: QueueRuntime | null },
  lock: ReturnType<typeof createTuiCommandLock>,
  notice: (text: string) => unknown,
  setEpoch: (update: (value: number) => number) => void,
): void {
  useEffect(() => {
    setMessageQueueAdder((message) => {
      const parked = lock.parkIncoming(message);
      if (parked) {
        notice(
          `Parked notification for ${parked.agentId ?? "unknown-agent"}/${parked.conversationId ?? "unknown-conversation"} during session activation; it was not sent. Retained for this TUI lifetime; no automatic replay. ${parked.text}`,
        );
        return;
      }
      const item =
        message.kind === "task_notification"
          ? {
              kind: "task_notification" as const,
              source: "task_notification" as const,
              text: message.text,
              content: message.content,
            }
          : {
              kind: "message" as const,
              source: message.source ?? ("user" as const),
              content: message.text,
            };
      queue.current?.enqueue(item);
      setEpoch((value) => value + 1);
    });
    return () => setMessageQueueAdder(null);
  }, [queue, lock, notice, setEpoch]);
}
