import { resolveModelHandleFromLlmConfig } from "@/agent/model-handles";
import type { Backend, ConversationCreateBody } from "@/backend";
import { isRecord } from "@/utils/type-guards";

export interface ConversationModelSnapshot {
  model: NonNullable<ConversationCreateBody["model"]>;
  model_settings?: ConversationCreateBody["model_settings"];
  contextWindow?: number;
}

function contextWindow(entity: unknown): number | undefined {
  if (!isRecord(entity)) return undefined;
  if (typeof entity.context_window_limit === "number") {
    return entity.context_window_limit;
  }
  if (isRecord(entity.llm_config)) {
    const value = entity.llm_config.context_window;
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** Snapshot overrides without rebuilding (and losing) provider-specific settings. */
export async function snapshotConversationModel(
  backend: Backend,
  agentId: string,
  conversationId: string | null,
): Promise<ConversationModelSnapshot> {
  // Use the captured backend, never the global selected backend. Local's turn
  // executor merges settings; Cloud's documented conversation settings replace.
  const localModelCatalog = backend.capabilities.localModelCatalog;
  const [agent, conversation] = await Promise.all([
    backend.retrieveAgent(agentId).then((value) => structuredClone(value)),
    conversationId && conversationId !== "default"
      ? backend
          .retrieveConversation(conversationId)
          .then((value) => structuredClone(value))
      : undefined,
  ]);
  if (conversation && conversation.agent_id !== agentId) {
    throw new Error("Mod create: source conversation belongs to another agent");
  }
  const agentModel =
    agent.model || resolveModelHandleFromLlmConfig(agent.llm_config);
  const model = conversation?.model || agentModel;
  if (!model) throw new Error("Mod create: effective model is unavailable");
  const sameModel = !conversation?.model || conversation.model === agentModel;
  const overrideSettings = conversation?.model_settings;
  // Local's executor accepts an open settings record, merging even across
  // provider discriminators and preserving Local-only fields (for example
  // context_window_limit and sampling_params). The SDK create union cannot
  // express that merge. Keep this assertion confined to the Local branch;
  // Cloud settings below remain checked against the SDK request union.
  const localSettings: Record<string, unknown> = {
    ...agent.model_settings,
    ...overrideSettings,
  };
  const settings: ConversationCreateBody["model_settings"] = localModelCatalog
    ? (localSettings as NonNullable<ConversationCreateBody["model_settings"]>)
    : overrideSettings && Object.keys(overrideSettings).length > 0
      ? overrideSettings
      : sameModel
        ? agent.model_settings
        : undefined;
  // Local turn execution: explicit conversation limit > conversation settings
  // limit > agent settings limit, even with a different model. Its projected
  // llm_config includes a compatibility default, not an execution fallback.
  // Persisted legacy llm_config limits are normalized into agent settings by
  // LocalStore before retrieval/execution.
  const localLimit = localSettings.context_window_limit;
  const explicitLimit = isRecord(conversation)
    ? conversation.context_window_limit
    : undefined;
  const window = localModelCatalog
    ? typeof explicitLimit === "number"
      ? explicitLimit
      : typeof localLimit === "number"
        ? localLimit
        : undefined
    : (contextWindow(conversation) ??
      (sameModel ? contextWindow(agent) : undefined));
  return {
    model,
    ...(settings != null ? { model_settings: settings } : {}),
    ...(window !== undefined ? { contextWindow: window } : {}),
  };
}
