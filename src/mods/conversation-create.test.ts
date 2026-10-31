import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateModelConfig } from "@/agent/modify";
import type { Backend, ConversationCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { ModConversationCreationError } from "@/mods/conversation-creation-error";
import { createModConversationHandle } from "@/mods/conversation-handle";
import { runWithModInvocationContext } from "@/mods/invocation-context";
import type { ModInvocationContext } from "@/mods/types";

function fixture() {
  const calls: Array<{ kind: string; id?: string; body?: unknown }> = [];
  const agent = {
    id: "agent-1",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      reasoning_effort: "high",
      temperature: 0.4,
    },
    llm_config: { context_window: 200000 },
  };
  const source = {
    id: "source",
    agent_id: agent.id,
    model: null as string | null,
    model_settings: null as Record<string, unknown> | null,
    context_window_limit: null as number | null,
  };
  let nextId = 0;
  const backend = {
    capabilities: { localModelCatalog: false },
    retrieveAgent: async (id: string) => {
      calls.push({ kind: "agent", id });
      return agent;
    },
    retrieveConversation: async (id: string) => {
      calls.push({ kind: "conversation", id });
      return source;
    },
    createConversation: async (body: ConversationCreateBody) => {
      calls.push({ kind: "create", body: structuredClone(body) });
      return { id: `fresh-${++nextId}`, agent_id: body.agent_id };
    },
    updateConversation: async (id: string, body: unknown) => {
      calls.push({ kind: "update", id, body });
      return {};
    },
  } as unknown as Backend;
  const options = {
    agentId: agent.id,
    conversationId: source.id,
    backend,
    workingDirectory: "/source",
    sendMessageStream: async () => {
      throw new Error("must not send");
    },
  };
  return {
    agent,
    source,
    backend,
    calls,
    options,
    handle: createModConversationHandle(options),
  };
}

function invocation(signal: AbortSignal, sessionId = "source") {
  return {
    agent: { id: "agent-1" },
    sessionId,
    signal,
  } as ModInvocationContext;
}

describe("inert scoped conversation creation", () => {
  test("creates distinct scoped handles with ordinary defaults and title, without reading history or model", async () => {
    const f = fixture();
    const first = await f.handle.create({ title: "Joined thread" });
    const second = await f.handle.create();
    expect([first.id, second.id, f.handle.id]).toEqual([
      "fresh-1",
      "fresh-2",
      "source",
    ]);
    expect(f.calls).toEqual([
      {
        kind: "create",
        body: { agent_id: "agent-1", summary: "Joined thread" },
      },
      { kind: "create", body: { agent_id: "agent-1" } },
    ]);
    await first.updateTitle?.("Updated");
    expect(f.calls.at(-1)).toEqual({
      kind: "update",
      id: "fresh-1",
      body: { summary: "Updated" },
    });
  });

  test("inherits effective agent defaults on Cloud facade", async () => {
    const f = fixture();
    const before = structuredClone(f.source);
    await f.handle.create({ inheritModel: true });
    expect(f.calls.find((c) => c.kind === "create")?.body).toEqual({
      agent_id: "agent-1",
      model: f.agent.model,
      model_settings: f.agent.model_settings,
    });
    expect(f.calls.at(-1)).toEqual({
      kind: "update",
      id: "fresh-1",
      body: { context_window_limit: 200000 },
    });
    expect(f.source).toEqual(before);
    expect(f.calls.map((c) => c.kind).sort()).toEqual([
      "agent",
      "conversation",
      "create",
      "update",
    ]);
  });

  test("preserves full override settings and explicit context on Cloud facade", async () => {
    const f = fixture();
    f.source.model = "anthropic/claude-sonnet-4-6";
    f.source.model_settings = {
      provider_type: "anthropic",
      max_tokens: 17000,
      effort: "medium",
      thinking: { type: "adaptive" },
    };
    f.source.context_window_limit = 150000;
    await f.handle.create({ inheritModel: true });
    expect(f.calls.find((c) => c.kind === "create")?.body).toEqual({
      agent_id: "agent-1",
      model: f.source.model,
      model_settings: f.source.model_settings,
    });
    expect(f.calls.at(-1)?.body).toEqual({ context_window_limit: 150000 });
  });

  test("does not apply agent provider settings to a different override model", async () => {
    const f = fixture();
    f.source.model = "anthropic/claude-sonnet-4-6";
    await f.handle.create({ inheritModel: true });
    expect(f.calls.find((c) => c.kind === "create")?.body).toEqual({
      agent_id: "agent-1",
      model: f.source.model,
    });
  });

  test("preparation failure exposes the already-created ID and never retries", async () => {
    const f = fixture();
    f.backend.updateConversation = async () => {
      throw new Error("preparation failed");
    };
    const failure = await f.handle
      .create({ inheritModel: true })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ModConversationCreationError);
    expect(failure.conversationId).toBe("fresh-1");
    expect(failure.agentId).toBe("agent-1");
    expect(failure.cause.message).toBe("preparation failed");
    expect(f.calls.filter((c) => c.kind === "create")).toHaveLength(1);
  });

  test("pins backend, source and cloned model before awaiting creation", async () => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const creating = new Promise<void>((resolve) => {
      started = resolve;
    });
    const create = f.backend.createConversation.bind(f.backend);
    f.backend.createConversation = async (body) => {
      started();
      await waiting;
      return create(body);
    };
    const pending = f.handle.create({ inheritModel: true });
    await creating;
    f.options.agentId = "other-agent";
    f.options.conversationId = "other-conversation";
    f.options.backend = {} as Backend;
    f.agent.model_settings.reasoning_effort = "low";
    release();
    const fresh = await pending;
    expect(fresh.id).toBe("fresh-1");
    expect(f.calls.find((c) => c.kind === "create")?.body).toMatchObject({
      agent_id: "agent-1",
      model_settings: { reasoning_effort: "high" },
    });
    await fresh.updateTitle?.("pinned");
    expect(f.calls.at(-1)?.id).toBe("fresh-1");
  });

  test("aborted invocation cannot create; cancellation after creation retains ID", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWithModInvocationContext(invocation(controller.signal), () =>
        f.handle.create(),
      ),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    const active = new AbortController();
    const create = f.backend.createConversation.bind(f.backend);
    f.backend.createConversation = async (body) => {
      const result = await create(body);
      active.abort();
      return result;
    };
    const failure = await runWithModInvocationContext(
      invocation(active.signal),
      () => f.handle.create(),
    ).catch((error) => error);
    expect(failure.conversationId).toBe("fresh-1");
  });

  test("rejects a mismatched invocation scope instead of retargeting", async () => {
    const f = fixture();
    await expect(
      runWithModInvocationContext(
        invocation(new AbortController().signal, "other"),
        () => f.handle.create(),
      ),
    ).rejects.toThrow("scope");
    expect(f.calls).toEqual([]);
  });
  test("LocalBackend persists fresh model/settings/window without copying source messages", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "mod-create-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Creation test",
        model: "openai/gpt-4.1",
      });
      const source = await backend.createConversation({ agent_id: agent.id });
      await backend.updateConversation(source.id, {
        model: "openai/gpt-4.1",
        model_settings: { provider_type: "openai", temperature: 0.3 },
      });
      await updateModelConfig(
        backend,
        { scope: "conversation", conversationId: source.id, agentId: agent.id },
        { contextWindow: 90000 },
      );
      const before = structuredClone(
        await backend.retrieveConversation(source.id),
      );
      const handle = createModConversationHandle({
        agentId: agent.id,
        backend,
        conversationId: source.id,
        sendMessageStream: async () => {
          throw new Error("must not send");
        },
      });
      const fresh = await handle.create({
        inheritModel: true,
        title: "Fresh local",
      });
      if (!fresh.id) throw new Error("created handle must have an ID");
      const record = await backend.retrieveConversation(fresh.id);
      expect(record.id).not.toBe(source.id);
      expect(record.summary).toBe("Fresh local");
      expect(record.model).toBe(before.model);
      expect(record.model_settings).toMatchObject(before.model_settings ?? {});
      expect(record).toMatchObject({
        context_window_limit: 90000,
        in_context_message_ids: [],
      });
      expect(await backend.retrieveConversation(source.id)).toEqual(before);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("pre-return backend failure stays explicitly unknown and is not retried", async () => {
    const f = fixture();
    const failure = new Error("connection lost before ID returned");
    let attempts = 0;
    f.backend.createConversation = async () => {
      attempts++;
      throw failure;
    };
    await expect(f.handle.create()).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  test("cancellation while reading the source prevents creation", async () => {
    const f = fixture();
    const controller = new AbortController();
    const read = f.backend.retrieveConversation.bind(f.backend);
    f.backend.retrieveConversation = async (id) => {
      const result = await read(id);
      controller.abort();
      return result;
    };
    await expect(
      runWithModInvocationContext(invocation(controller.signal), () =>
        f.handle.create({ inheritModel: true }),
      ),
    ).rejects.toThrow();
    expect(f.calls.some((c) => c.kind === "create")).toBe(false);
  });
});
