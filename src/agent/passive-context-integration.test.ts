import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateClientSkillsPayloadCache } from "@/agent/client-skills";
import type { Backend } from "@/backend/backend";
import { __testSetBackend } from "@/backend/backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { sendMessageStreamWithBackend } from "./message";
import { createPassiveContextHost } from "./passive-context-host";

const roots: string[] = [];
afterEach(async () => {
  __testSetBackend(null);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(executor?: HeadlessTurnExecutor) {
  const root = await mkdtemp(join(tmpdir(), "context-integration-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  const backend: Backend = new LocalBackend({
    storageDir: join(root, "provider"),
    stateStorageDir: state,
    memfsEnabled: false,
    executionMode: "deterministic",
    executor,
  });
  const agent = await backend.createAgent({ name: "integration" });
  const conversation = await backend.createConversation({ agent_id: agent.id });
  const scope = { agentId: agent.id, conversationId: conversation.id };
  const host = createPassiveContextHost({
    directory: join(root, "inbox"),
    getBackend: () => backend,
  });
  const skillsDirectory = join(root, "skills");
  await mkdir(skillsDirectory);
  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    [],
    {
      runtimeContext: {
        workingDirectory: root,
        skillsDirectory,
        mcpOriginatorSuperRunId: null,
      },
    },
  );
  return {
    root,
    backend,
    scope,
    host,
    skillsDirectory,
    options: {
      agentId: agent.id,
      skillSources: ["project" as const],
      actingUserId: null,
      preparedToolContext,
    },
  };
}
test("per-human wrappers retain the ordinary backend client-skills baseline", async () => {
  const f = await fixture();
  const bodies: Parameters<
    typeof f.backend.createConversationMessageStream
  >[1][] = [];
  const create = f.backend.createConversationMessageStream.bind(f.backend);
  f.backend.createConversationMessageStream = async (id, body, options) => {
    bodies.push(structuredClone(body));
    return create(id, body, options);
  };
  const context = f.host.context(f.scope);
  async function send(id: string) {
    await context.record({ id, text: id, visibility: "model" });
    const transport = await f.host.transport(f.scope, id);
    for await (const _ of await sendMessageStreamWithBackend(
      transport,
      f.scope.conversationId,
      [{ role: "user", otid: id, content: "hello" }],
      f.options,
    )) {
    }
  }
  await send("h1");
  await mkdir(join(f.skillsDirectory, "late-skill"));
  await writeFile(
    join(f.skillsDirectory, "late-skill", "SKILL.md"),
    "---\nname: late-skill\ndescription: New skill\n---\nDO_NOT_EAGERLY_INCLUDE_BODY",
  );
  invalidateClientSkillsPayloadCache();
  await send("h2");
  expect(bodies[1]?.messages).toHaveLength(3);
  expect(JSON.stringify(bodies[1]?.messages?.at(-1))).toContain("late-skill");
  expect(JSON.stringify(bodies)).not.toContain("DO_NOT_EAGERLY_INCLUDE_BODY");
});
test("midstream resume and status reads retain captured backend after ambient replacement", async () => {
  const f = await fixture();
  let resumed = 0;
  let ambientCalls = 0;
  f.backend.streamRunMessages = async () => {
    resumed++;
    const stream = createAssistantMessageStream();
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    const binding = (await f.host.context(f.scope).submissions())[0];
    stream[Symbol.asyncIterator] = async function* () {
      yield {
        message_type: "user_message",
        id: "context-replay",
        date: new Date().toISOString(),
        content: "BLUE-42",
        otid: binding?.contextMessageOtid,
      };
      yield* { [Symbol.asyncIterator]: iterate };
    };
    return stream;
  };
  const create = f.backend.createConversationMessageStream.bind(f.backend);
  f.backend.createConversationMessageStream = async (id, body, options) => {
    const original = await create(id, body, options);
    original[Symbol.asyncIterator] = async function* () {
      yield {
        message_type: "assistant_message",
        content: "partial",
        id: "partial-message",
        date: new Date().toISOString(),
        run_id: "original-run",
      };
      throw new Error("stream disconnected");
    };
    return original;
  };
  const context = f.host.context(f.scope);
  await context.record({ id: "r", text: "context", visibility: "model" });
  const transport = await f.host.transport(f.scope, "human");
  const stream = await sendMessageStreamWithBackend(
    transport,
    f.scope.conversationId,
    [{ role: "user", content: "hello", otid: "human" }],
    f.options,
  );
  const other = new LocalBackend({
    storageDir: join(f.root, "other"),
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  other.streamRunMessages = async () => {
    ambientCalls++;
    throw new Error("wrong principal");
  };
  other.retrieveRun = async () => {
    ambientCalls++;
    throw new Error("wrong principal");
  };
  __testSetBackend(other);
  const buffers = createBuffers(f.scope.agentId);
  const result = await drainStreamWithResume(
    stream,
    buffers,
    () => {},
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    { initialDelayMs: 0, maxAttempts: 1, maxDelayMs: 0 },
  );
  expect(result.stopReason).toBe("end_turn");
  expect(JSON.stringify(buffers)).not.toContain("BLUE-42");
  expect(resumed).toBe(1);
  expect(ambientCalls).toBe(0);
  expect((await context.submissions())[0]?.outcome).toBe("uncertain");
});

test("message shutdown retry keeps the frozen human and composed request", async () => {
  const f = await fixture();
  const bodies: unknown[] = [];
  const create = f.backend.createConversationMessageStream.bind(f.backend);
  f.backend.createConversationMessageStream = async (id, body, options) => {
    bodies.push(structuredClone(body));
    if (bodies.length === 1) {
      throw Object.assign(new Error("shutdown"), {
        status: 503,
        error: {
          errorCode: "cloud_api_shutting_down",
          admitted: false,
          retryable: true,
        },
        headers: new Headers({ "retry-after": "0" }),
      });
    }
    return create(id, body, options);
  };
  const context = f.host.context(f.scope);
  await context.record({ id: "remote", text: "context", visibility: "model" });
  const transport = await f.host.transport(f.scope, "human-retry");
  for await (const _ of await sendMessageStreamWithBackend(
    transport,
    f.scope.conversationId,
    [{ role: "user", content: "hello", otid: "human-retry" }],
    f.options,
  )) {
  }
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(await context.submissions()).toHaveLength(1);
});

test.each([409, 429, 503])(
  "message dispatch fences ambiguous %s without replay",
  async (status) => {
    const f = await fixture();
    let posts = 0;
    f.backend.createConversationMessageStream = async () => {
      posts++;
      throw Object.assign(new Error("approval or transient conflict"), {
        status,
      });
    };
    const context = f.host.context(f.scope);
    await context.record({
      id: "remote",
      text: "context",
      visibility: "model",
    });
    const transport = await f.host.transport(f.scope, "ambiguous-human");
    await expect(
      sendMessageStreamWithBackend(
        transport,
        f.scope.conversationId,
        [{ role: "user", content: "hello", otid: "ambiguous-human" }],
        f.options,
      ),
    ).rejects.toThrow("Automatic retry is fenced");
    expect(posts).toBe(1);
    expect((await context.submissions())[0]?.outcome).toBe("uncertain");
    expect((await context.reconcile("ambiguous-human"))?.outcome).toBe(
      "uncertain",
    );
  },
);

test("title and description seeds exclude host context while preserving real human and assistant content", async () => {
  const f = await fixture({
    async execute() {
      return createAssistantMessageStream({
        content: "The context says BLUE-42; I will fix the build.",
      });
    },
  });
  const previous = process.env.LETTA_CONFIG_DIR;
  process.env.LETTA_CONFIG_DIR = join(f.root, "config");
  __testSetBackend(f.backend);
  try {
    const { getHostContextRecords } = await import("./host-context-records");
    const host = getHostContextRecords();
    const context = host.context(f.scope);
    await context.record({
      id: "remote",
      text: "BLUE-42",
      visibility: "model",
    });
    const transport = await host.transport(f.scope, "human-seed");
    for await (const _ of await transport.createConversationMessageStream(
      f.scope.conversationId,
      {
        messages: [
          { role: "user", content: "Fix the build", otid: "human-seed" },
        ],
        streaming: true,
      },
    )) {
    }
    const { listConversationTitleMessages } = await import(
      "@/cli/helpers/conversation-title"
    );
    const { listConversationDescriptionMessages } = await import(
      "./conversation-description"
    );
    const raw = (
      await f.backend.listConversationMessages(f.scope.conversationId, {
        order: "asc",
      })
    ).getPaginatedItems();
    expect(JSON.stringify(raw)).toContain("BLUE-42");
    const title = await listConversationTitleMessages(
      f.backend,
      f.scope.conversationId,
    );
    const description = await listConversationDescriptionMessages(
      f.backend,
      f.scope.conversationId,
    );
    for (const seed of [title, description]) {
      expect(seed[0]).toEqual({ role: "user", content: "Fix the build" });
      expect(seed.some((row) => row.role === "assistant")).toBe(true);
      expect(seed.filter((row) => row.role === "user")).toEqual([
        { role: "user", content: "Fix the build" },
      ]);
      expect(seed.find((row) => row.role === "assistant")?.content).toBe(
        "The context says BLUE-42; I will fix the build.",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previous;
  }
});
