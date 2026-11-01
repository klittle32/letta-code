import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Letta from "@letta-ai/letta-client";
import { APIBackend } from "@/backend/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { createPassiveContextHost } from "./passive-context-host";
import { capturePassiveContextSession } from "./passive-context-session";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "context-regression-"));
  roots.push(path);
  return path;
}
const scope = { agentId: "agent-test", conversationId: "conv-test" };
const body = (otid: string) => ({
  messages: [{ role: "user" as const, content: "hello", otid }],
  streaming: true as const,
});
async function api() {
  const directory = join(await root(), "context-inbox");
  let token = "first";
  let org = "org-one";
  let metadataStatus = 200;
  let metadataCalls = 0;
  let posts = 0;
  const getClient = async () =>
    new Letta({
      apiKey: token,
      baseURL: "https://context.test",
      fetch: async (input, init) => {
        if (String(input).endsWith("/v1/metadata/balance")) {
          metadataCalls++;
          return Response.json(
            { organization_id: org },
            { status: metadataStatus },
          );
        }
        if (init?.method === "POST") {
          posts++;
          return new Response(
            'data: {"message_type":"stop_reason","stop_reason":"end_turn"}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json([]);
      },
    });
  const backend = new APIBackend({ getClient });
  const options = {
    directory,
    getBackend: () => backend,
    capture: (options: Parameters<typeof capturePassiveContextSession>[0]) =>
      capturePassiveContextSession({
        ...options,
        getBackend: () => backend,
        getClient,
      }),
  };
  return {
    backend,
    options,
    host: createPassiveContextHost(options),
    token(value: string) {
      token = value;
    },
    org(value: string) {
      org = value;
    },
    metadataStatus(value: number) {
      metadataStatus = value;
    },
    counts: () => ({ metadataCalls, posts }),
  };
}
test("failed API capture cannot poison normal inputs, including after restart", async () => {
  const f = await api();
  f.metadataStatus(404);
  await expect(
    f.host
      .context(scope)
      .record({ id: "r", text: "data", visibility: "model" }),
  ).rejects.toThrow();
  const calls = f.counts().metadataCalls;
  expect(await f.host.transport(scope, "h1")).toBe(f.backend);
  expect(await createPassiveContextHost(f.options).transport(scope, "h2")).toBe(
    f.backend,
  );
  expect(f.counts().metadataCalls).toBe(calls);
});
test("token rotation reacquires NEW work without migrating an uncertain binding", async () => {
  const f = await api();
  const original = f.host.context(scope);
  await original.record({ id: "old", text: "old", visibility: "model" });
  const old = await f.host.transport(scope, "old-human");
  for await (const _ of await old.createConversationMessageStream(
    scope.conversationId,
    body("old-human"),
  )) {
  }
  await original.record({
    id: "pending",
    text: "pending",
    visibility: "model",
  });
  f.token("rotated");
  const next = await f.host.transport(scope, "new-human");
  for await (const _ of await next.createConversationMessageStream(
    scope.conversationId,
    body("new-human"),
  )) {
  }
  expect(f.counts().posts).toBe(2);
  expect(
    (await original.submissions()).map((s) => [
      s.id,
      s.outcome,
      s.records.map((r) => r.id),
    ]),
  ).toEqual([
    ["old-human", "uncertain", ["old"]],
    ["new-human", "uncertain", ["pending"]],
  ]);
  f.org("org-two");
  f.token("another-account");
  expect(await f.host.transport(scope, "different-org-human")).toBe(f.backend);
  expect((await original.submissions())[0]?.outcome).toBe("uncertain");
  expect(await f.host.context(scope).list()).toEqual([]);
});
test("local reconciliation with missing canonical evidence stays uncertain without SDK page methods", async () => {
  const directory = await root();
  const state = join(directory, "state");
  await mkdir(state);
  const backend = new LocalBackend({
    storageDir: join(directory, "provider"),
    stateStorageDir: state,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  const agent = await backend.createAgent({ name: "Reconcile" });
  const conversation = await backend.createConversation({ agent_id: agent.id });
  const localScope = { agentId: agent.id, conversationId: conversation.id };
  const capture = async (
    options: Parameters<typeof capturePassiveContextSession>[0],
  ) => {
    const session = await capturePassiveContextSession(options);
    await session.inbox.record({ id: "r", text: "data", visibility: "model" });
    await session.inbox.bindExplicitSubmission("absent-human");
    await session.inbox.markDispatch("absent-human");
    return session;
  };
  const host = createPassiveContextHost({
    directory: join(directory, "inbox"),
    getBackend: () => backend,
    capture,
  });
  expect(
    (await host.context(localScope).reconcile("absent-human"))?.outcome,
  ).toBe("uncertain");
});

test("only typed not-admitted shutdown permits same-identity dispatch retry", async () => {
  const f = await api();
  let attempts = 0;
  const originalCapture = f.options.capture;
  const host = createPassiveContextHost({
    ...f.options,
    capture: async (options) => {
      const session = await originalCapture(options);
      return {
        ...session,
        transport: {
          ...session.transport,
          async createConversationMessageStream(...args) {
            if (++attempts === 1) {
              const error = new Error("shutdown") as Error & {
                status: number;
                error: unknown;
              };
              error.status = 503;
              error.error = {
                errorCode: "cloud_api_shutting_down",
                admitted: false,
                retryable: true,
              };
              throw error;
            }
            return session.transport.createConversationMessageStream(...args);
          },
        },
      };
    },
  });
  const context = host.context(scope);
  await context.record({ id: "r", text: "data", visibility: "model" });
  const transport = await host.transport(scope, "h");
  await expect(
    transport.createConversationMessageStream(scope.conversationId, body("h")),
  ).rejects.toThrow("shutdown");
  expect((await context.submissions())[0]?.outcome).toBe("prepared");
  const stream = await transport.createConversationMessageStream(
    scope.conversationId,
    body("h"),
  );
  for await (const _ of stream) {
  }
  expect(attempts).toBe(2);
  expect((await context.submissions())[0]?.outcome).toBe("uncertain");
});
test.each([409, 503, 429])(
  "ambiguous %s POST explicitly fences automatic retry without releasing context",
  async (status) => {
    const f = await api();
    let posts = 0;
    const host = createPassiveContextHost({
      ...f.options,
      capture: async (options) => {
        const session = await f.options.capture(options);
        return {
          ...session,
          transport: {
            ...session.transport,
            async createConversationMessageStream() {
              posts++;
              throw Object.assign(
                new Error(status === 409 ? "PENDING_APPROVAL" : "transient"),
                { status },
              );
            },
          },
        };
      },
    });
    const context = host.context(scope);
    await context.record({ id: "r", text: "data", visibility: "model" });
    const transport = await host.transport(scope, "human");
    await expect(
      transport.createConversationMessageStream(
        scope.conversationId,
        body("human"),
      ),
    ).rejects.toThrow("uncertain");
    await expect(
      transport.createConversationMessageStream(
        scope.conversationId,
        body("human"),
      ),
    ).rejects.toThrow("reconciliation");
    expect(posts).toBe(1);
    expect((await context.submissions())[0]?.outcome).toBe("uncertain");
  },
);
test("prepared crash recovery releases only never-dispatched selection under dispatch lock", async () => {
  const f = await api();
  const session = await f.options.capture({
    ...scope,
    directory: join(
      f.options.directory,
      (await import("node:crypto"))
        .createHash("sha256")
        .update(JSON.stringify(scope))
        .digest("hex"),
    ),
  });
  await session.inbox.record({ id: "r", text: "data", visibility: "model" });
  await session.inbox.bindExplicitSubmission("crashed-before-dispatch");
  const host = createPassiveContextHost(f.options);
  const context = host.context(scope);
  expect((await context.reconcile("crashed-before-dispatch"))?.outcome).toBe(
    "rejected",
  );
  const transport = await host.transport(scope, "new-human");
  for await (const _ of await transport.createConversationMessageStream(
    scope.conversationId,
    body("new-human"),
  )) {
  }
  expect((await context.submissions())[1]?.records.map((r) => r.id)).toEqual([
    "r",
  ]);
});

test("older failed capture cannot evict a newer successful cache entry", async () => {
  const f = await api();
  let captures = 0;
  let fail!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const host = createPassiveContextHost({
    ...f.options,
    capture: async (options) => {
      captures++;
      const session = await f.options.capture(options);
      if (captures === 1) {
        reached();
        await new Promise<void>((_, reject) => {
          fail = () => reject(new Error("old capture failed"));
        });
      }
      return session;
    },
  });
  const older = host
    .context(scope)
    .list()
    .catch(() => []);
  await waiting;
  await host
    .context(scope)
    .record({ id: "new", text: "new", visibility: "model" });
  fail();
  await older;
  await host.transport(scope, "human");
  expect(captures).toBe(2);
});
test("captured explicit cursor pagination crosses 100 rows and missing evidence is not acceptance", async () => {
  const directory = await root();
  const state = join(directory, "state");
  await mkdir(state);
  const backend = new LocalBackend({
    storageDir: join(directory, "provider"),
    stateStorageDir: state,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  const agent = await backend.createAgent({ name: "Pagination" });
  const conversation = await backend.createConversation({ agent_id: agent.id });
  for await (const _ of await backend.createConversationMessageStream(
    conversation.id,
    {
      messages: Array.from({ length: 120 }, (_, index) => ({
        role: "user" as const,
        content: `older-${index}`,
        otid: `older-${index}`,
      })),
      streaming: true,
    },
  )) {
  }
  const reads: (string | null | undefined)[] = [];
  const list = backend.listConversationMessages.bind(backend);
  backend.listConversationMessages = async (id, query, request) => {
    reads.push(query?.after);
    return list(id, query, request);
  };
  const bindingId = "missing-human";
  const capture = async (
    options: Parameters<typeof capturePassiveContextSession>[0],
  ) => {
    const session = await capturePassiveContextSession(options);
    await session.inbox.record({ id: "r", text: "data", visibility: "model" });
    await session.inbox.bindExplicitSubmission(bindingId);
    await session.inbox.markDispatch(bindingId);
    return session;
  };
  const localScope = { agentId: agent.id, conversationId: conversation.id };
  const host = createPassiveContextHost({
    directory: join(directory, "inbox"),
    getBackend: () => backend,
    capture,
  });
  const context = host.context(localScope);
  expect((await context.reconcile(bindingId))?.outcome).toBe("uncertain");
  expect(reads.length).toBe(2);
  expect(reads[1]).toBeString();
  const binding = (await context.submissions())[0];
  if (!binding) throw new Error("missing binding");
  for await (const _ of await backend.createConversationMessageStream(
    conversation.id,
    {
      messages: [
        { role: "user", otid: binding.contextMessageOtid, content: "context" },
        { role: "user", otid: bindingId, content: "human" },
      ],
      streaming: true,
    },
  )) {
  }
  expect((await context.reconcile(bindingId))?.outcome).toBe("accepted");
  expect(reads.length).toBe(4);
});

test("cancellation after prepare but before dispatch releases only the never-sent binding", async () => {
  const f = await api();
  const abort = new AbortController();
  const host = createPassiveContextHost({
    ...f.options,
    capture: async (options) => {
      const source = await f.options.capture(options);
      return {
        ...source,
        async assertCurrent(request) {
          if (
            (await source.inbox.getSubmission("cancel-before-send"))
              ?.outcome === "prepared"
          )
            abort.abort();
          await source.assertCurrent(request);
        },
      };
    },
  });
  const context = host.context(scope);
  await context.record({ id: "remote", text: "data", visibility: "model" });
  const transport = await host.transport(
    scope,
    "cancel-before-send",
    abort.signal,
  );
  await expect(
    transport.createConversationMessageStream(
      scope.conversationId,
      body("cancel-before-send"),
      { signal: abort.signal },
    ),
  ).rejects.toThrow();
  expect(f.counts().posts).toBe(0);
  expect((await context.submissions())[0]?.outcome).toBe("rejected");
  const next = await host.transport(scope, "next-human");
  for await (const _ of await next.createConversationMessageStream(
    scope.conversationId,
    body("next-human"),
  )) {
  }
  expect((await context.submissions())[1]?.records.map((r) => r.id)).toEqual([
    "remote",
  ]);
});

test("restart projection and accepted-only human send need no live metadata", async () => {
  const f = await api();
  const context = f.host.context(scope);
  await context.record({ id: "r", text: "BLUE-42", visibility: "model" });
  const transport = await f.host.transport(scope, "original-human");
  for await (const _ of await transport.createConversationMessageStream(
    scope.conversationId,
    body("original-human"),
  )) {
  }
  const submission = (await context.submissions())[0];
  if (!submission) throw new Error("Missing binding");
  // Positive proof is supplied through the original inbox only in this fixture.
  const { createHash } = await import("node:crypto");
  const source = await f.options.capture({
    ...scope,
    directory: join(
      f.options.directory,
      createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
    ),
  });
  await source.inbox.settleSubmission(submission.id, "accepted");
  const calls = f.counts().metadataCalls;
  f.metadataStatus(502);
  const restarted = createPassiveContextHost(f.options);
  const rows = [
    {
      id: "c",
      message_type: "user_message",
      content: "BLUE-42",
      otid: submission.contextMessageOtid,
    },
    {
      id: "h",
      message_type: "user_message",
      content: "human",
      otid: "original-human",
    },
    {
      id: "approval",
      message_type: "approval_request_message",
      tool_call: { name: "Read", arguments: "{}", tool_call_id: "pending" },
    },
  ] as import("@letta-ai/letta-client/resources/agents/messages").Message[];
  expect(
    (await restarted.projectMessages(scope, rows)).map((row) => row.id),
  ).toEqual(["h", "approval"]);
  expect(await restarted.transport(scope, "next-human")).toBe(f.backend);
  expect(f.counts().metadataCalls).toBe(calls);
  const { __testSetBackend } = await import("@/backend/backend");
  const previousConfig = process.env.LETTA_CONFIG_DIR;
  process.env.LETTA_CONFIG_DIR = (await import("node:path")).dirname(
    f.options.directory,
  );
  f.backend.getConversationResumeTail = async () => ({
    conversation: {
      id: scope.conversationId,
      in_context_message_ids: ["approval"],
    } as import("@letta-ai/letta-client/resources/conversations").Conversation,
    messages: rows,
  });
  f.backend.retrieveMessage = async () => [
    rows[2] as import("@letta-ai/letta-client/resources/agents/messages").Message,
  ];
  __testSetBackend(f.backend);
  try {
    const { getResumeDataFromBackend } = await import("./check-approval");
    const resume = await getResumeDataFromBackend(
      {
        id: scope.agentId,
      } as import("@letta-ai/letta-client/resources/agents/agents").AgentState,
      scope.conversationId,
    );
    expect(resume.messageHistory.map((row) => row.id)).toContain("h");
    expect(JSON.stringify(resume.messageHistory)).not.toContain("BLUE-42");
    expect(resume.pendingApprovals).toHaveLength(1);
    expect(f.counts().metadataCalls).toBe(calls);
  } finally {
    __testSetBackend(null);
    if (previousConfig === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previousConfig;
  }
  await expect(
    restarted
      .context(scope)
      .record({ id: "new", text: "pending", visibility: "model" }),
  ).rejects.toThrow();
  f.metadataStatus(200);
  await context.record({
    id: "still-pending",
    text: "pending needs verification",
    visibility: "model",
  });
  f.metadataStatus(502);
  const before = f.counts().posts;
  await expect(
    createPassiveContextHost(f.options).transport(scope, "guarded-human"),
  ).rejects.toThrow();
  expect(f.counts().posts).toBe(before);
});

test.each(["before", "after"])(
  "%s-dispatch cancellation retains user-abort classification",
  async (when) => {
    const { APIUserAbortError } = await import(
      "@letta-ai/letta-client/core/error"
    );
    const { isUserAbortError } = await import("./approval-execution");
    const f = await api();
    const abort = new AbortController();
    const host = createPassiveContextHost({
      ...f.options,
      capture: async (options) => {
        const source = await f.options.capture(options);
        return {
          ...source,
          async assertCurrent(request) {
            if (
              when === "before" &&
              (await source.inbox.getSubmission("human"))?.outcome ===
                "prepared"
            )
              abort.abort();
            return source.assertCurrent(request);
          },
          transport: {
            ...source.transport,
            async createConversationMessageStream() {
              throw new APIUserAbortError();
            },
          },
        };
      },
    });
    const context = host.context(scope);
    await context.record({ id: "r", text: "data", visibility: "model" });
    const transport = await host.transport(scope, "human", abort.signal);
    let failure: unknown;
    try {
      await transport.createConversationMessageStream(
        scope.conversationId,
        body("human"),
        { signal: abort.signal },
      );
    } catch (error) {
      failure = error;
    }
    expect(isUserAbortError(failure)).toBe(true);
    if (when === "after")
      expect(String((failure as Error).cause)).toContain("uncertain");
    expect((await context.submissions())[0]?.outcome).toBe(
      when === "before" ? "rejected" : "uncertain",
    );
  },
);

test("human content needs exact authorization: captured offline reads work, cold outage and account change fail closed", async () => {
  const f = await api();
  await f.host.context(scope).record({
    id: "human",
    text: "original-principal-visible",
    visibility: "human",
  });
  const rows = await f.host.humanSnapshot(scope);
  expect(rows).toHaveLength(1);
  const id = rows[0]?.id;
  if (!id) throw new Error("Missing namespace ID");
  f.metadataStatus(502);
  expect(await f.host.humanSnapshot(scope)).toEqual(rows);
  await expect(
    createPassiveContextHost(f.options).humanSnapshot(scope),
  ).rejects.toThrow();
  f.token("rotated");
  f.org("other-org");
  f.metadataStatus(200);
  await expect(f.host.assertHumanCurrent(scope, id)).rejects.toThrow();
  expect(await f.host.humanSnapshot(scope)).toEqual([]);
});

test("principal change during asynchronous human snapshot cannot return previous-principal content", async () => {
  const f = await api();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = createPassiveContextHost({
    ...f.options,
    capture: async (options) => {
      const source = await f.options.capture(options);
      return {
        ...source,
        inbox: {
          ...source.inbox,
          async humanEntries() {
            const entries = await source.inbox.humanEntries();
            entered?.();
            await hold;
            return entries;
          },
        },
      };
    },
  });
  await host.context(scope).record({
    id: "only-original",
    text: "PRIVATE_ORIGINAL",
    visibility: "human",
  });
  const snapshot = host.humanSnapshot(scope);
  await started;
  f.token("new-token");
  f.org("new-org");
  release?.();
  await expect(snapshot).rejects.toThrow("session changed");
  expect(await host.humanSnapshot(scope)).toEqual([]);
});

test("human validation recaptures same-organization token rotation but rejects a new principal", async () => {
  const f = await api();
  const original = f.host.context(scope);
  await original.record({
    id: "visible",
    text: "original",
    visibility: "human",
  });
  const rows = await f.host.humanSnapshot(scope);
  const id = rows[0]?.id;
  if (!id) throw new Error("Missing context identity");
  f.token("same-org-rotated");
  await f.host.assertHumanCurrent(scope, id);
  expect(await f.host.humanSnapshot(scope)).toEqual(rows);
  f.token("new-org-token");
  f.org("org-two");
  await expect(f.host.assertHumanCurrent(scope, id)).rejects.toThrow(
    "principal changed",
  );
  expect(await f.host.humanSnapshot(scope)).toEqual([]);
  expect(await original.list()).toHaveLength(1);
});
