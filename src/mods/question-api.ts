import { isAskUserQuestions } from "@/ask-user-question";
import { getModInvocationContext } from "@/mods/invocation-context";
import type { ModAskOptions, ModAskResult, ModOwner } from "@/mods/types";

export interface ModQuestionRequest {
  questions: ModAskOptions["questions"];
  agentId: string | null;
  conversationId: string | null;
  owner: ModOwner;
  signal: AbortSignal;
}
export type ModQuestionHandler = (
  request: ModQuestionRequest,
) => Promise<ModAskResult>;

/** Bind owner lifetime once; invocation identity is read only from async scope. */
export function createModAsk(
  owner: ModOwner,
  ownerSignal: AbortSignal,
  handler?: ModQuestionHandler,
): (options: ModAskOptions) => Promise<ModAskResult> {
  return async (options) => {
    if (!handler) return { status: "dismissed", reason: "unavailable" };
    const context = getModInvocationContext();
    if (!context) return { status: "dismissed", reason: "unavailable" };
    const signals = [ownerSignal, context.signal, options.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return { status: "dismissed", reason: "cancelled" };
    if (!isAskUserQuestions(options.questions)) {
      throw new Error(
        "letta.ui.ask requires 1–4 valid questions with 2–4 options each",
      );
    }
    return handler({
      questions: structuredClone(options.questions),
      agentId: context.agent.id,
      conversationId: context.sessionId,
      owner: { ...owner },
      signal,
    });
  };
}
