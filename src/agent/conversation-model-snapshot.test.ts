import { expect, test } from "bun:test";
import type { OpenAIModelSettings } from "@letta-ai/letta-client/resources/agents/agents";
import { snapshotConversationModel } from "@/agent/conversation-model-snapshot";
import type { Backend } from "@/backend";

function cloudFacade(agent: unknown, conversation?: unknown): Backend {
  return {
    capabilities: { localModelCatalog: false },
    retrieveAgent: async () => agent,
    retrieveConversation: async () => {
      if (!conversation) throw new Error("must not read default conversation");
      return conversation;
    },
  } as unknown as Backend;
}

const agent = {
  model: "openai/gpt-4.1",
  model_settings: {
    provider_type: "openai",
    temperature: 0.2,
  } satisfies OpenAIModelSettings,
  llm_config: { context_window: 100000 },
};

test("null/default source uses scoped agent defaults without retrieving ambiguous default ID", async () => {
  for (const id of [null, "default"]) {
    expect(
      await snapshotConversationModel(cloudFacade(agent), "agent-1", id),
    ).toEqual({
      model: agent.model,
      model_settings: agent.model_settings,
      contextWindow: 100000,
    });
  }
});

test("empty settings on the same model inherit agent settings; explicit window is exact", async () => {
  const backend = cloudFacade(agent, {
    agent_id: "agent-1",
    model: agent.model,
    model_settings: {},
    context_window_limit: 128000,
  });
  expect(await snapshotConversationModel(backend, "agent-1", "source")).toEqual(
    {
      model: agent.model,
      model_settings: agent.model_settings,
      contextWindow: 128000,
    },
  );
});

test("Cloud settings-only overrides replace settings without discarding the agent model", async () => {
  const settings = {
    provider_type: "openai",
    reasoning: { reasoning_effort: "low" },
  } satisfies OpenAIModelSettings;
  const backend = cloudFacade(agent, {
    agent_id: "agent-1",
    model_settings: settings,
  });
  expect(await snapshotConversationModel(backend, "agent-1", "source")).toEqual(
    {
      model: agent.model,
      model_settings: settings,
      contextWindow: 100000,
    },
  );
});

test("Cloud different model without settings/window uses destination backend model defaults", async () => {
  const backend = cloudFacade(agent, {
    agent_id: "agent-1",
    model: "anthropic/claude-sonnet-4-6",
  });
  expect(await snapshotConversationModel(backend, "agent-1", "source")).toEqual(
    { model: "anthropic/claude-sonnet-4-6" },
  );
});

test("uses the model-handle owner for legacy agent model resolution", async () => {
  const backend = cloudFacade({
    llm_config: { model: "openai/gpt-4.1", model_endpoint_type: "openai" },
  });
  expect(await snapshotConversationModel(backend, "agent-1", null)).toEqual({
    model: "openai/gpt-4.1",
  });
});

test("rejects missing model and wrong-agent source instead of guessing", async () => {
  await expect(
    snapshotConversationModel(cloudFacade({}), "agent-1", null),
  ).rejects.toThrow("unavailable");
  await expect(
    snapshotConversationModel(
      cloudFacade(agent, { agent_id: "other" }),
      "agent-1",
      "source",
    ),
  ).rejects.toThrow("another agent");
});
