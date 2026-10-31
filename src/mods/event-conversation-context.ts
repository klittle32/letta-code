import { sendMessageStreamWithBackend } from "@/agent/message";
import type { Backend } from "@/backend";
import { createModConversationHandle } from "./conversation-handle";
import type { ModContext } from "./types";

/** Event scope overrides the live context without retargeting its conversation handle. */
export function createEventConversationContext(
  context: ModContext,
  event: { agentId?: string | null; conversationId?: string | null },
  backend?: Backend,
) {
  return {
    agent: { ...context.agent, id: event.agentId ?? context.agent.id },
    sessionId: event.conversationId ?? context.sessionId,
    conversation: createModConversationHandle({
      agentId:
        typeof event.agentId === "string" ? event.agentId : context.agent.id,
      conversationId:
        typeof event.conversationId === "string"
          ? event.conversationId
          : context.sessionId,
      backend,
      sendMessageStream: sendMessageStreamWithBackend,
      workingDirectory: context.cwd,
    }),
  };
}
