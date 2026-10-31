import { snapshotConversationModel } from "@/agent/conversation-model-snapshot";
import { updateModelConfig } from "@/agent/modify";
import type { Backend } from "@/backend";
import { ModConversationCreationError } from "@/mods/conversation-creation-error";
import { loadModConversationHistoryFromBackend } from "@/mods/conversation-history";
import { publishConversationTitleChange } from "@/mods/conversation-title-events";
import { getModInvocationContext } from "@/mods/invocation-context";
import type {
  ModConversationHandle,
  ModConversationMessage,
  ModConversationSendMessageOptions,
  ModConversationSendMessageRequestOptions,
  ModUpdateLlmConfigOptions,
} from "@/mods/types";

type SendModConversationMessageStream = (
  backend: Backend,
  conversationId: string,
  messages: ModConversationMessage[],
  options?: ModConversationSendMessageOptions & { agentId?: string },
  requestOptions?: ModConversationSendMessageRequestOptions,
) => ReturnType<ModConversationHandle["sendMessageStream"]>;

export function createModConversationHandle(options: {
  agentId?: string | null;
  backend?: Backend;
  conversationId?: string | null;
  sendMessageStream: SendModConversationMessageStream;
  workingDirectory?: string | null;
}): ModConversationHandle {
  const conversationId = options.conversationId ?? "default";
  const requireBackend = () => {
    if (!options.backend) {
      throw new Error("Mod conversation backend is not available");
    }
    return options.backend;
  };

  return {
    id: options.conversationId ?? null,
    async create(createOptions = {}) {
      // Capture all identities before the first await. Never consult a mutable
      // active-session ref to finish an operation started in another scope.
      const backend = requireBackend();
      const agentId = options.agentId;
      const sourceId = options.conversationId ?? null;
      const workingDirectory = options.workingDirectory;
      const sendMessageStream = options.sendMessageStream;
      const invocation = getModInvocationContext();
      const signal = invocation?.signal;
      if (!agentId) throw new Error("Mod create: agentId is not available");
      if (
        invocation &&
        (invocation.agent.id !== agentId || invocation.sessionId !== sourceId)
      ) {
        throw new Error(
          "Mod create: invocation scope does not match the source handle",
        );
      }
      signal?.throwIfAborted();
      const { inheritModel, title } = createOptions;
      const snapshot = inheritModel
        ? await snapshotConversationModel(backend, agentId, sourceId)
        : undefined;
      signal?.throwIfAborted();
      const created = await backend.createConversation({
        agent_id: agentId,
        ...(title !== undefined ? { summary: title } : {}),
        ...(snapshot
          ? {
              model: snapshot.model,
              ...(snapshot.model_settings !== undefined
                ? { model_settings: snapshot.model_settings }
                : {}),
            }
          : {}),
      });
      // Do not abort the create request itself: after an ID is returned, even
      // cancellation must carry that ID. Pre-return backend failures stay unknown.
      try {
        signal?.throwIfAborted();
        if (snapshot?.contextWindow !== undefined) {
          await updateModelConfig(
            backend,
            { scope: "conversation", conversationId: created.id, agentId },
            { contextWindow: snapshot.contextWindow },
          );
        }
        signal?.throwIfAborted();
      } catch (cause) {
        throw new ModConversationCreationError(agentId, created.id, cause);
      }
      return createModConversationHandle({
        agentId,
        backend,
        conversationId: created.id,
        workingDirectory,
        sendMessageStream,
      });
    },
    async fork(forkOptions) {
      const forked = await requireBackend().forkConversation(conversationId, {
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...forkOptions,
      });
      return createModConversationHandle({
        ...options,
        conversationId: forked.id,
      });
    },
    getHistory(historyOptions) {
      return loadModConversationHistoryFromBackend(
        requireBackend(),
        {
          agentId: options.agentId,
          conversationId,
        },
        historyOptions,
      );
    },
    async updateTitle(title) {
      if (!options.conversationId) {
        throw new Error(
          "Mod updateTitle: conversationId is not available for this conversation",
        );
      }
      await requireBackend().updateConversation(options.conversationId, {
        summary: title,
      });
      publishConversationTitleChange({
        conversationId: options.conversationId,
        title,
      });
    },
    sendMessageStream(messages, sendOptions, requestOptions) {
      return options.sendMessageStream(
        requireBackend(),
        conversationId,
        messages,
        {
          ...(options.agentId ? { agentId: options.agentId } : {}),
          ...(options.workingDirectory
            ? { workingDirectory: options.workingDirectory }
            : {}),
          ...sendOptions,
        },
        requestOptions,
      );
    },
    async updateLlmConfig(update: ModUpdateLlmConfigOptions) {
      const backend = requireBackend();
      const { scope, ...config } = update;
      if (scope === "agent") {
        if (!options.agentId) {
          throw new Error(
            "Mod updateLlmConfig: agentId is not available for an agent-scope update",
          );
        }
        await updateModelConfig(
          backend,
          { scope: "agent", agentId: options.agentId },
          config,
        );
        return;
      }
      await updateModelConfig(
        backend,
        { scope: "conversation", conversationId, agentId: options.agentId },
        config,
      );
    },
  };
}
