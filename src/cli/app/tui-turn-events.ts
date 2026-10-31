import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import type { ModContext } from "@/mods/types";
import type { createTuiTurnControl } from "./tui-turn-control";

/** Bind once: late terminal events must retain the original turn and scope. */
export function bindTuiTurnEvents(
  control: ReturnType<typeof createTuiTurnControl>,
  events: LocalModAdapter["events"],
  context: ModContext,
): void {
  const original = {
    ...context,
    agent: { ...context.agent, id: control.turn.agentId },
    sessionId: control.turn.conversationId,
  };
  control.setTerminalHandler(async (stopReason, assistantMessage) => {
    const event = {
      agentId: control.turn.agentId,
      conversationId: control.turn.conversationId,
      stopReason,
      assistantMessage,
      continue: undefined as string | undefined,
    };
    await events.emit("turn_end", event, original);
    return event.continue;
  });
}

/** Defer hook feedback until the current stack unwinds, keeping its abort fence. */
export function scheduleTuiContinuation(
  content: string,
  signal: AbortSignal,
  process: (input: MessageCreate[], options: { allowReentry: true }) => unknown,
): void {
  const otid = randomUUID();
  setTimeout(() => {
    if (!signal.aborted)
      process([{ type: "message", role: "user", content, otid }], {
        allowReentry: true,
      });
  }, 0);
}
