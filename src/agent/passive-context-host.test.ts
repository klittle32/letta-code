import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";
import { createPassiveContextHost } from "./passive-context-host";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "context-host-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  const backend = new LocalBackend({
    storageDir: join(root, "provider"),
    stateStorageDir: state,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  const agent = await backend.createAgent({ name: "Context host" });
  const conversation = await backend.createConversation({ agent_id: agent.id });
  const options = { directory: join(root, "inbox"), getBackend: () => backend };
  const host = createPassiveContextHost(options);
  const scope = { agentId: agent.id, conversationId: conversation.id };
  return { backend, host, scope, options };
}
test("record is immutable, passive, durable and separate from message history", async () => {
  const f = await fixture();
  const context = f.host.context(f.scope);
  await context.record({
    id: "remote",
    text: "shared text",
    visibility: "model",
  });
  expect(
    await f.backend.latestConversationRun(f.scope.conversationId),
  ).toBeNull();
  expect(await context.list()).toHaveLength(1);
  await expect(
    context.record({ id: "remote", text: "changed", visibility: "model" }),
  ).rejects.toThrow();
  await context.record({ id: "thought", text: "private", visibility: "human" });
  expect(
    await createPassiveContextHost(f.options).context(f.scope).list(),
  ).toHaveLength(2);
});
test("ordinary input does not capture a session or look up metadata", async () => {
  const f = await fixture();
  let captures = 0;
  const host = createPassiveContextHost({
    ...f.options,
    capture: async () => {
      captures++;
      throw new Error("unexpected capture");
    },
  });
  expect(await host.transport(f.scope, undefined)).toBe(f.backend);
  expect(await host.transport(f.scope, "human")).toBe(f.backend);
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    host.transport(f.scope, "cancelled-human", aborted.signal),
  ).rejects.toThrow();
  expect(captures).toBe(0);
});
test("only explicit human dispatch binds, and no canonical rows leaves uncertainty across restart", async () => {
  const f = await fixture();
  const context = f.host.context(f.scope);
  await context.record({ id: "remote", text: "data", visibility: "model" });
  expect(await f.host.transport(f.scope, undefined)).toBe(f.backend);
  expect(await context.submissions()).toEqual([]);
  const transport = await f.host.transport(f.scope, "human-1");
  const body = {
    messages: [{ role: "user" as const, content: "hello", otid: "human-1" }],
    streaming: true as const,
  };
  const stream = await transport.createConversationMessageStream(
    f.scope.conversationId,
    body,
  );
  expect((await context.submissions())[0]?.outcome).toBe("uncertain");
  // Not consuming the stream cannot establish acceptance.
  stream.controller.abort();
  const restored = createPassiveContextHost(f.options).context(f.scope);
  expect((await restored.submissions())[0]?.outcome).toBe("uncertain");
  await expect(
    transport.createConversationMessageStream(f.scope.conversationId, body),
  ).rejects.toThrow("reconciliation");
  await expect(
    transport.createConversationMessageStream(f.scope.conversationId, {
      ...body,
      messages: [{ ...body.messages[0]!, content: "changed" }],
    }),
  ).rejects.toThrow("different input");
});
test("local stream without canonical input rows stays uncertain until captured history reconciliation", async () => {
  const f = await fixture();
  const context = f.host.context(f.scope);
  await context.record({ id: "remote", text: "data", visibility: "model" });
  const transport = await f.host.transport(f.scope, "human-2");
  const stream = await transport.createConversationMessageStream(
    f.scope.conversationId,
    {
      messages: [{ role: "user", content: "hello", otid: "human-2" }],
      streaming: true,
    },
  );
  for await (const _ of stream) {
    /* canonical stream */
  }
  expect((await context.submissions())[0]?.outcome).toBe("uncertain");
  expect((await context.reconcile("human-2"))?.outcome).toBe("accepted");
});

test("original uncertain scope remains inspectable and reconciles after a backend switch", async () => {
  const f = await fixture();
  const next = await fixture();
  let active = f.backend;
  const host = createPassiveContextHost({
    directory: f.options.directory,
    getBackend: () => active,
  });
  const original = host.context(f.scope);
  await original.record({
    id: "old",
    text: "original scope",
    visibility: "model",
  });
  const transport = await host.transport(f.scope, "switched-human");
  const stream = await transport.createConversationMessageStream(
    f.scope.conversationId,
    {
      messages: [{ role: "user", content: "hello", otid: "switched-human" }],
      streaming: true,
    },
  );
  stream.controller.abort();
  active = next.backend;
  expect((await original.submissions())[0]?.outcome).toBe("uncertain");
  await expect(
    original.record({ id: "late", text: "late", visibility: "model" }),
  ).rejects.toThrow();
  const newer = host.context(f.scope);
  expect(await newer.list()).toEqual([]);
  expect(await newer.submissions()).toEqual([]);
  expect(await host.transport(f.scope, "switched-human")).toBe(next.backend);
  expect((await original.reconcile("switched-human"))?.outcome).toBe(
    "accepted",
  );
  expect(await newer.submissions()).toEqual([]);
});

test("frozen final request rejects changed options or reminders under reused identity", async () => {
  const f = await fixture();
  const context = f.host.context(f.scope);
  await context.record({ id: "first", text: "first", visibility: "model" });
  const transport = await f.host.transport(f.scope, "final-human");
  const body = {
    messages: [
      { role: "user" as const, content: "hello", otid: "final-human" },
      { role: "user" as const, content: "runtime reminder" },
    ],
    streaming: true as const,
  };
  const stream = await transport.createConversationMessageStream(
    f.scope.conversationId,
    body,
  );
  stream.controller.abort();
  await context.record({ id: "second", text: "second", visibility: "model" });
  expect(
    (await context.submissions())[0]?.records.map((row) => row.id),
  ).toEqual(["first"]);
  await expect(
    transport.createConversationMessageStream(f.scope.conversationId, {
      ...body,
      override_model: "changed",
    }),
  ).rejects.toThrow("different input");
  await expect(
    transport.createConversationMessageStream(f.scope.conversationId, {
      ...body,
      messages: [
        body.messages[0]!,
        { role: "user", content: "changed reminder" },
      ],
    }),
  ).rejects.toThrow("different input");
});

test("concurrent requests with one human identity dispatch at most once", async () => {
  const f = await fixture();
  const context = f.host.context(f.scope);
  await context.record({ id: "r", text: "data", visibility: "model" });
  const transport = await f.host.transport(f.scope, "concurrent-human");
  const body = {
    messages: [
      { role: "user" as const, content: "hello", otid: "concurrent-human" },
    ],
    streaming: true as const,
  };
  const results = await Promise.allSettled([
    transport.createConversationMessageStream(f.scope.conversationId, body),
    transport.createConversationMessageStream(f.scope.conversationId, body),
  ]);
  for (const result of results)
    if (result.status === "fulfilled") result.value.controller.abort();
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
});

test("positive canonical rows on the original dispatch stream settle acceptance before terminal output", async () => {
  const f = await fixture();
  const context = f.host.context(f.scope);
  const create = f.backend.createConversationMessageStream.bind(f.backend);
  f.backend.createConversationMessageStream = async (id, body, options) => {
    expect((await context.submissions())[0]?.outcome).toBe("uncertain");
    const stream = await create(id, body, options);
    const iterator = stream[Symbol.asyncIterator].bind(stream);
    // Canonical rows from this local request's persisted history model a backend
    // that emits its accepted input rows on the original stream.
    const history = await f.backend.listConversationMessages(id, {
      order: "asc",
    });
    stream[Symbol.asyncIterator] = async function* () {
      for (const row of history.getPaginatedItems()) {
        if (
          row.message_type === "user_message" &&
          body.messages?.some((message) => message.otid === row.otid)
        )
          yield row;
      }
      for await (const row of { [Symbol.asyncIterator]: iterator }) yield row;
    };
    return stream;
  };
  await context.record({ id: "r", text: "data", visibility: "model" });
  const transport = await f.host.transport(f.scope, "canonical-human");
  const stream = await transport.createConversationMessageStream(
    f.scope.conversationId,
    {
      messages: [{ role: "user", content: "hello", otid: "canonical-human" }],
      streaming: true,
    },
  );
  for await (const _ of stream) {
    /* observe canonical input rows */
  }
  expect((await context.submissions())[0]?.outcome).toBe("accepted");
});

test("model-only projection uses durable source identity across restart and leaves raw history intact", async () => {
  const f = await fixture();
  const context = f.host.context(f.scope);
  await context.record({ id: "model", text: "BLUE-42", visibility: "model" });
  const transport = await f.host.transport(f.scope, "human-visible");
  for await (const _ of await transport.createConversationMessageStream(
    f.scope.conversationId,
    {
      messages: [
        {
          role: "user",
          content: "Passive collaborator context (human-authored text)",
          otid: "human-visible",
        },
      ],
      streaming: true,
    },
  )) {
  }
  const raw = (
    await f.backend.listConversationMessages(f.scope.conversationId, {
      order: "asc",
    })
  ).getPaginatedItems();
  expect(raw.filter((row) => row.message_type === "user_message")).toHaveLength(
    2,
  );
  const projected = await createPassiveContextHost(f.options).projectMessages(
    f.scope,
    raw,
  );
  expect(
    projected
      .filter((row) => row.message_type === "user_message")
      .map((row) => row.otid),
  ).toEqual(["human-visible"]);
  expect(raw.filter((row) => row.message_type === "user_message")).toHaveLength(
    2,
  );
  const { backfillBuffers } = await import("@/cli/helpers/backfill");
  const { createBuffers, toLines } = await import("@/cli/helpers/accumulator");
  const buffers = createBuffers(f.scope.agentId);
  backfillBuffers(buffers, projected);
  expect(JSON.stringify(toLines(buffers))).not.toContain("BLUE-42");
  expect(JSON.stringify(toLines(buffers))).toContain("human-authored text");
});

test("human and both records persist exact display placements without inference or automatic binding", async () => {
  const f = await fixture();
  let invalidations = 0;
  const dispose = f.host.subscribeHuman(
    f.scope,
    () => ({ after: { otid: "stable-human" } }),
    () => invalidations++,
  );
  const context = f.host.context(f.scope);
  await context.record({
    id: "human",
    text: "human-only",
    visibility: "human",
  });
  const first = await f.host.humanSnapshot(f.scope);
  expect(first).toHaveLength(1);
  expect(first[0]?.placement).toEqual({ after: { otid: "stable-human" } });
  await context.record({ id: "both", text: "shared", visibility: "both" });
  await context.record({ id: "both", text: "shared", visibility: "both" });
  const rows = await f.host.humanSnapshot(f.scope);
  expect(rows).toHaveLength(2);
  expect(rows[1]?.placement).toEqual({ after: { otid: "stable-human" } });
  expect(invalidations).toBe(3);
  expect(await context.submissions()).toEqual([]);
  expect(
    await f.backend.latestConversationRun(f.scope.conversationId),
  ).toBeNull();
  const restart = createPassiveContextHost(f.options);
  expect(await restart.humanSnapshot(f.scope)).toEqual(rows);
  const transport = await f.host.transport(f.scope, "explicit-human");
  for await (const _ of await transport.createConversationMessageStream(
    f.scope.conversationId,
    {
      messages: [{ role: "user", content: "hello", otid: "explicit-human" }],
      streaming: true,
    },
  )) {
  }
  expect((await context.submissions())[0]?.records.map((r) => r.id)).toEqual([
    "both",
  ]);
  expect(await restart.humanSnapshot(f.scope)).toEqual(rows);
  dispose();
});

test("human snapshot never projects original-store content into a replacement store", async () => {
  const f = await fixture();
  let backend = f.backend;
  const host = createPassiveContextHost({
    ...f.options,
    getBackend: () => backend,
  });
  const original = host.context(f.scope);
  await original.record({
    id: "private",
    text: "original-store-only",
    visibility: "human",
  });
  const before = await host.humanSnapshot(f.scope);
  expect(before).toHaveLength(1);
  const other = await fixture();
  backend = other.backend;
  expect(await host.humanSnapshot(f.scope)).toEqual([]);
  expect(await original.list()).toHaveLength(1);
  await expect(
    original.record({ id: "later", text: "no", visibility: "both" }),
  ).rejects.toThrow();
});

test("a clipped page without a stable boundary does not fabricate conversation start", async () => {
  const f = await fixture();
  f.backend.listConversationMessages = async () =>
    ({
      getPaginatedItems: () =>
        Array.from({ length: 100 }, () => ({
          message_type: "assistant_message",
        })),
    }) as unknown as Awaited<
      ReturnType<typeof f.backend.listConversationMessages>
    >;
  await f.host
    .context(f.scope)
    .record({ id: "clipped", text: "local", visibility: "human" });
  expect((await f.host.humanSnapshot(f.scope))[0]?.placement).toBeNull();
});

test("first human record uses the active stable boundary without a history lookup", async () => {
  const f = await fixture();
  const dispose = f.host.subscribeHuman(
    f.scope,
    () => ({ after: { otid: "active-human" } }),
    () => {},
  );
  f.backend.listConversationMessages = async () => {
    throw new Error("unnecessary history lookup");
  };
  try {
    await f.host
      .context(f.scope)
      .record({ id: "first", text: "local", visibility: "human" });
    expect((await f.host.humanSnapshot(f.scope))[0]?.placement).toEqual({
      after: { otid: "active-human" },
    });
  } finally {
    dispose();
  }
});

test("history placement skips raw tool returns for a resolvable whole-message boundary", async () => {
  const f = await fixture();
  f.backend.listConversationMessages = async () =>
    ({
      getPaginatedItems: () => [
        {
          id: "return",
          message_type: "tool_return_message",
          tool_call_id: "tool",
        },
        {
          id: "call",
          otid: "call-otid",
          message_type: "tool_call_message",
          tool_call: { tool_call_id: "tool", name: "Shell", arguments: "{}" },
        },
        {
          id: "user",
          message_type: "user_message",
          otid: "human",
          content: "hello",
        },
      ],
    }) as unknown as Awaited<
      ReturnType<typeof f.backend.listConversationMessages>
    >;
  await f.host
    .context(f.scope)
    .record({ id: "visible", text: "local", visibility: "human" });
  const rows = await f.host.humanSnapshot(f.scope);
  const contextId = rows[0]?.id;
  if (!contextId) throw new Error("Missing context row");
  expect(rows[0]?.placement).toEqual({
    after: { messageId: "call", otid: "call-otid", toolCallId: "tool" },
  });
  const { mergeContextTranscript } = await import(
    "@/cli/helpers/context-transcript"
  );
  const { createBuffers, toLines } = await import("@/cli/helpers/accumulator");
  const { backfillBuffers } = await import("@/cli/helpers/backfill");
  const buffers = createBuffers(f.scope.agentId);
  const history = await f.backend.listConversationMessages(
    f.scope.conversationId,
  );
  backfillBuffers(buffers, history.getPaginatedItems().reverse());
  expect(
    mergeContextTranscript(toLines(buffers), rows).map((row) => row.id),
  ).toEqual(["human", "call-otid", contextId]);
});
