import type {
  ModInvocationContext,
  ModOwner,
  ModSessionActivationOptions,
  ModSessionActivationResult,
} from "./types";

export interface ModSessionActivationRequest
  extends ModSessionActivationOptions {
  agentId: string | null;
  sourceConversationId: string | null;
  sourceWorkingDirectory: string;
  owner: ModOwner;
  signal: AbortSignal;
  invocationSignal?: AbortSignal;
}
export type ModSessionActivationHandler = (
  request: ModSessionActivationRequest,
) => Promise<ModSessionActivationResult>;

/** Capture exact invocation scope before any await, including detached commands. */
export function bindModSessionContext<T extends ModInvocationContext>(
  context: T,
  owner: ModOwner,
  ownerSignal: AbortSignal,
  handler?: ModSessionActivationHandler,
): T {
  const source = {
    agentId: context.agent.id,
    sourceConversationId: context.sessionId,
    sourceWorkingDirectory: context.cwd,
    owner: { ...owner },
  };
  const invocationSignal = context.signal;
  const session = {
    activate: async (options: ModSessionActivationOptions) => {
      if (!handler)
        return {
          status: "refused",
          reason: "Session activation is unavailable",
        };
      const signal = AbortSignal.any([
        ownerSignal,
        ...(invocationSignal ? [invocationSignal] : []),
        ...(options.signal ? [options.signal] : []),
      ]);
      if (signal.aborted)
        return {
          status: "refused",
          reason: "Session activation cancelled",
        };
      if (!options.conversationId?.trim() || !options.workingDirectory?.trim())
        return {
          status: "refused",
          reason: "Exact conversation and working directory are required",
        };
      return handler({
        ...source,
        conversationId: options.conversationId,
        workingDirectory: options.workingDirectory,
        signal,
        invocationSignal,
      });
    },
  };
  return new Proxy(context, {
    get(target, property, receiver) {
      return property === "session"
        ? session
        : Reflect.get(target, property, receiver);
    },
  });
}
