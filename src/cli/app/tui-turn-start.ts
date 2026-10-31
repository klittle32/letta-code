import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { getTurnStartCancel } from "@/mods/turn-start-cancel";

function hasUserMessageInput(
  input: Array<MessageCreate | ApprovalCreate>,
): boolean {
  return input.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      item.type !== "approval" &&
      "role" in item &&
      item.role === "user",
  );
}

function isTurnInputArray(
  value: unknown,
): value is Array<MessageCreate | ApprovalCreate> {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

/** Best-effort turn-start transformation, before any host stream starts. */
export async function emitTuiTurnStart(
  input: Array<MessageCreate | ApprovalCreate>,
  adapter: Pick<LocalModAdapter, "events" | "context">,
) {
  if (!hasUserMessageInput(input)) return { input, cancelReason: null };
  const context = { ...adapter.context };
  const event = {
    agentId: context.agent.id,
    conversationId: context.sessionId,
    input,
  };
  try {
    await adapter.events.emit("turn_start", event, context);
    return {
      input: isTurnInputArray(event.input) ? event.input : input,
      cancelReason: getTurnStartCancel(event)?.reason ?? null,
    };
  } catch {
    return { input, cancelReason: null };
  }
}
