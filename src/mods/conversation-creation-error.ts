/** Creation returned an ID, but preparation or invocation cancellation failed.
 * Never retry creation automatically; the caller can retain this exact ID.
 */
export class ModConversationCreationError extends Error {
  readonly agentId: string;
  readonly conversationId: string;

  constructor(agentId: string, conversationId: string, cause: unknown) {
    super(
      `Mod conversation ${conversationId} was created but preparation did not complete`,
      { cause },
    );
    this.name = "ModConversationCreationError";
    this.agentId = agentId;
    this.conversationId = conversationId;
  }
}
