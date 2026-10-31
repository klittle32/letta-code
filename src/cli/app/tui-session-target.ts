import type { Backend } from "@/backend";

/** Freshness is backend evidence, not membership in a process-local minted-ID set. */
export async function validateFreshTuiConversation(
  backend: Backend,
  agentId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await backend.retrieveConversation(conversationId);
  if (conversation.id !== conversationId || conversation.agent_id !== agentId)
    throw new Error("Destination is not owned by the source agent");
  if (
    conversation.archived ||
    conversation.last_message_at !== null ||
    !Array.isArray(conversation.in_context_message_ids) ||
    conversation.in_context_message_ids.length
  )
    throw new Error("Destination is used or freshness cannot be verified");
  const messages = await backend.listConversationMessages(conversationId, {
    limit: 1,
  });
  if (messages.getPaginatedItems().length)
    throw new Error("Destination already contains messages");
  // Re-read after history lookup: a newly accepted request invalidates freshness.
  const current = await backend.retrieveConversation(conversationId);
  if (
    current.id !== conversationId ||
    current.agent_id !== agentId ||
    current.archived ||
    current.last_message_at !== null ||
    !Array.isArray(current.in_context_message_ids) ||
    current.in_context_message_ids.length
  )
    throw new Error("Destination changed during validation");
}
