import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotConversationModel } from "@/agent/conversation-model-snapshot";
import { updateModelConfig } from "@/agent/modify";
import {
  DeterministicPongExecutor,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { createModConversationHandle } from "@/mods/conversation-handle";

async function localFixture() {
  const storageDir = await mkdtemp(join(tmpdir(), "mod-create-parity-"));
  const executed: HeadlessTurnExecutorInput[] = [];
  const deterministic = new DeterministicPongExecutor();
  const options = {
    storageDir,
    memfsEnabled: false,
    executor: {
      async execute(input: HeadlessTurnExecutorInput) {
        executed.push(structuredClone(input));
        return deterministic.execute(input);
      },
    },
  };
  const backend = new LocalBackend(options);
  const agent = await backend.createAgent({
    name: "Snapshot parity",
    model: "openai/snapshot-source-model",
    model_settings: { provider_type: "openai", temperature: 0.4 },
    context_window_limit: 90000,
  });
  return {
    backend,
    agent,
    executed,
    storageDir,
    options,
    async run(conversationId: string, runtime = backend) {
      const stream = await runtime.createConversationMessageStream(
        conversationId,
        {
          agent_id: agent.id,
          messages: [{ role: "user", content: "deterministic probe" }],
        },
      );
      for await (const _chunk of stream) {
        /* Drain the injected deterministic executor. */
      }
      const input = executed.at(-1);
      if (!input) throw new Error("executor was not invoked");
      return input.agent;
    },
    handle(conversationId: string, runtime = backend) {
      return createModConversationHandle({
        agentId: agent.id,
        backend: runtime,
        conversationId,
        sendMessageStream: async () => {
          throw new Error("creation must not send");
        },
      });
    },
    cleanup: () => rm(storageDir, { recursive: true, force: true }),
  };
}

test("Local creation pins the actual turn's merged agent temperature and conversation reasoning", async () => {
  const f = await localFixture();
  try {
    const source = await f.backend.createConversation({
      agent_id: f.agent.id,
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "low" },
      },
    });
    const effective = await f.run(source.id);
    expect(effective.model_settings).toMatchObject({
      temperature: 0.4,
      reasoning: { reasoning_effort: "low" },
    });
    const count = f.executed.length;
    const fresh = await f.handle(source.id).create({ inheritModel: true });
    expect(f.executed).toHaveLength(count);
    await f.backend.updateAgent(f.agent.id, {
      model_settings: { provider_type: "openai", temperature: 0.9 },
    });
    if (!fresh.id) throw new Error("missing created ID");
    expect((await f.run(fresh.id)).model_settings).toEqual(
      effective.model_settings,
    );
    expect((await f.run(source.id)).model_settings.temperature).toBe(0.9);
  } finally {
    await f.cleanup();
  }
});

for (const kind of [
  "agent settings",
  "conversation settings",
  "explicit conversation",
] as const) {
  test(`Local different-model snapshot matches actual execution window precedence: ${kind}`, async () => {
    const f = await localFixture();
    try {
      const expected =
        kind === "agent settings"
          ? 90000
          : kind === "conversation settings"
            ? 80000
            : 70000;
      const source = await f.backend.createConversation({
        agent_id: f.agent.id,
        model: "openai/snapshot-other-model",
      });
      if (kind !== "agent settings") {
        // The SDK omits this Local-supported setting from its provider union.
        const settings = {
          provider_type: "openai" as const,
          context_window_limit: 80000,
        };
        await f.backend.updateConversation(source.id, {
          model_settings: settings,
        });
      }
      if (kind === "explicit conversation") {
        await updateModelConfig(
          f.backend,
          { scope: "conversation", conversationId: source.id },
          { contextWindow: 70000 },
        );
      }
      const effective = await f.run(source.id);
      expect(effective.model_settings.context_window_limit).toBe(expected);
      const snapshot = await snapshotConversationModel(
        f.backend,
        f.agent.id,
        source.id,
      );
      expect(snapshot.contextWindow).toBe(expected);
      const fresh = await f.handle(source.id).create({ inheritModel: true });
      await f.backend.updateAgent(f.agent.id, { context_window_limit: 60000 });
      if (!fresh.id) throw new Error("missing created ID");
      const createdEffective = await f.run(fresh.id);
      expect(createdEffective.model).toBe(effective.model);
      expect(createdEffective.model_settings).toEqual(effective.model_settings);
    } finally {
      await f.cleanup();
    }
  });
}

test("Local projected llm_config's compatibility window is not an execution fallback", async () => {
  const f = await localFixture();
  try {
    const agent = await f.backend.createAgent({
      name: "No explicit limit",
      model: "openai/snapshot-source-model",
    });
    const source = await f.backend.createConversation({ agent_id: agent.id });
    const projected = await f.backend.retrieveAgent(agent.id);
    expect(projected.llm_config.context_window).toBe(128000);
    expect(projected.model_settings).not.toHaveProperty("context_window_limit");
    const snapshot = await snapshotConversationModel(
      f.backend,
      agent.id,
      source.id,
    );
    expect(snapshot.contextWindow).toBeUndefined();
    // Observe actual execution for this agent rather than treating the shim as authority.
    const stream = await f.backend.createConversationMessageStream(source.id, {
      agent_id: agent.id,
      messages: [{ role: "user", content: "probe" }],
    });
    for await (const _chunk of stream) {
      /* deterministic */
    }
    expect(f.executed.at(-1)?.agent.model_settings).not.toHaveProperty(
      "context_window_limit",
    );
  } finally {
    await f.cleanup();
  }
});

test("legacy persisted llm_config window is normalized into settings before Local execution/snapshot", async () => {
  const f = await localFixture();
  try {
    const path = join(
      f.storageDir,
      "agents",
      `${Buffer.from(f.agent.id).toString("base64url")}.json`,
    );
    const stored = JSON.parse(await readFile(path, "utf8"));
    delete stored.model_settings.context_window_limit;
    stored.llm_config = { context_window: 75000 };
    await writeFile(path, JSON.stringify(stored));
    const reloaded = new LocalBackend(f.options);
    const source = await reloaded.createConversation({
      agent_id: f.agent.id,
      model: "openai/snapshot-other-model",
    });
    const effective = await f.run(source.id, reloaded);
    expect(effective.model_settings.context_window_limit).toBe(75000);
    expect(
      (await snapshotConversationModel(reloaded, f.agent.id, source.id))
        .contextWindow,
    ).toBe(75000);
  } finally {
    await f.cleanup();
  }
});

test("Local catalog-populated conversation defaults outrank the agent just as in execution", async () => {
  const f = await localFixture();
  try {
    const source = await f.backend.createConversation({
      agent_id: f.agent.id,
      model: "openai/gpt-4.1-mini",
    });
    const effective = await f.run(source.id);
    const snapshot = await snapshotConversationModel(
      f.backend,
      f.agent.id,
      source.id,
    );
    expect(snapshot.model_settings).toEqual(effective.model_settings);
    const effectiveWindow = effective.model_settings.context_window_limit;
    if (typeof effectiveWindow !== "number")
      throw new Error("catalog window must be numeric");
    expect(snapshot.contextWindow).toBe(effectiveWindow);
    const fresh = await f.handle(source.id).create({ inheritModel: true });
    await f.backend.updateAgent(f.agent.id, { context_window_limit: 60000 });
    if (!fresh.id) throw new Error("missing created ID");
    expect((await f.run(fresh.id)).model_settings).toEqual(
      effective.model_settings,
    );
  } finally {
    await f.cleanup();
  }
});
