import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Letta from "@letta-ai/letta-client";
import { APIBackend, type Backend } from "@/backend/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { capturePassiveContextSession } from "./passive-context-session";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "passive-session-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function local(name = "state") {
  const provider = join(root, "provider");
  const state = join(root, name);
  await mkdir(provider, { recursive: true });
  await mkdir(state, { recursive: true });
  const backend = new LocalBackend({
    storageDir: provider,
    stateStorageDir: state,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  const agent = await backend.createAgent({ name: "Passive context test" });
  const conversation = await backend.createConversation({ agent_id: agent.id });
  return {
    backend,
    provider,
    state,
    agentId: agent.id,
    conversationId: conversation.id,
  };
}
function options(backend: Backend, agentId: string, conversationId: string) {
  return {
    getBackend: () => backend,
    agentId,
    conversationId,
    directory: join(root, "private-inbox"),
  };
}
const input = {
  id: "record-one",
  text: "collaborator text",
  visibility: "both" as const,
};

test("local session uses actual state store and reopens persisted host records without inference", async () => {
  const f = await local();
  const first = await capturePassiveContextSession(
    options(f.backend, f.agentId, f.conversationId),
  );
  expect(first.scope.backend).toContain(await realpath(f.state));
  expect(first.scope.backend).not.toContain(f.provider);
  expect(first.scope.account).toBe("local-store");
  await first.inbox.record(input);
  const restoredBackend = new LocalBackend({
    storageDir: f.provider,
    stateStorageDir: f.state,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  const restored = await capturePassiveContextSession(
    options(restoredBackend, f.agentId, f.conversationId),
  );
  expect(restored.scope).toEqual(first.scope);
  expect(await restored.inbox.list()).toHaveLength(1);
  expect(
    await first.transport.listConversationMessages(f.conversationId),
  ).toBeDefined();
  expect(await f.backend.latestConversationRun(f.conversationId)).toBeNull();
  expect("forkConversation" in first.transport).toBe(false);
  expect("capabilities" in first.transport).toBe(false);
});

test("isolates stores sharing provider settings, agents, and conversations", async () => {
  const a = await local("state-a");
  const b = await local("state-b");
  const first = await capturePassiveContextSession(
    options(a.backend, a.agentId, a.conversationId),
  );
  await first.inbox.record(input);
  const secondAgent = await a.backend.createAgent({ name: "Other agent" });
  const secondConversation = await a.backend.createConversation({
    agent_id: a.agentId,
  });
  for (const session of [
    await capturePassiveContextSession(
      options(b.backend, a.agentId, a.conversationId),
    ),
    await capturePassiveContextSession(
      options(a.backend, secondAgent.id, a.conversationId),
    ),
    await capturePassiveContextSession(
      options(a.backend, a.agentId, secondConversation.id),
    ),
  ])
    expect(await session.inbox.list()).toEqual([]);
});

test("symlink aliases share scope; retargeting is fenced for dispatch and reconciliation", async () => {
  const f = await local();
  const alias = join(root, "alias");
  await symlink(f.state, alias, "dir");
  const aliased = new LocalBackend({
    storageDir: f.provider,
    stateStorageDir: alias,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  const session = await capturePassiveContextSession(
    options(aliased, f.agentId, f.conversationId),
  );
  const direct = await capturePassiveContextSession(
    options(f.backend, f.agentId, f.conversationId),
  );
  expect(session.scope).toEqual(direct.scope);
  await session.inbox.record(input);
  await session.inbox.bindExplicitSubmission("human-one");
  await session.inbox.markDispatch("human-one");
  await rm(alias);
  const replacement = join(root, "replacement");
  await mkdir(replacement);
  await symlink(replacement, alias, "dir");
  await expect(session.assertCurrent()).rejects.toThrow("changed");
  await expect(
    session.transport.listConversationMessages(f.conversationId),
  ).rejects.toThrow("changed");
  await expect(
    session.transport.createConversationMessageStream(f.conversationId, {
      messages: [],
    }),
  ).rejects.toThrow("changed");
  expect((await direct.inbox.getSubmission("human-one"))?.outcome).toBe(
    "uncertain",
  );
});

test("directory replacement changes local durable namespace and fences old instance", async () => {
  const f = await local();
  const session = await capturePassiveContextSession(
    options(f.backend, f.agentId, f.conversationId),
  );
  await session.inbox.record(input);
  await rename(f.state, `${f.state}-old`);
  await mkdir(f.state);
  await expect(session.assertCurrent()).rejects.toThrow("changed");
  const fresh = new LocalBackend({
    storageDir: f.provider,
    stateStorageDir: f.state,
    memfsEnabled: false,
  });
  const replacement = await capturePassiveContextSession(
    options(fresh, f.agentId, f.conversationId),
  );
  expect(replacement.scope.backend).not.toBe(session.scope.backend);
  expect(await replacement.inbox.list()).toEqual([]);
});

test("backend replacement is fenced while reconciliation stays on original unchanged local store", async () => {
  const f = await local();
  let backend: Backend = f.backend;
  const session = await capturePassiveContextSession({
    ...options(backend, f.agentId, f.conversationId),
    getBackend: () => backend,
  });
  backend = new LocalBackend({
    storageDir: f.provider,
    stateStorageDir: f.state,
    memfsEnabled: false,
  });
  await expect(session.assertCurrent()).rejects.toThrow("changed");
  expect(
    await session.transport.listConversationMessages(f.conversationId),
  ).toBeDefined();
  await expect(
    session.transport.createConversationMessageStream(f.conversationId, {
      messages: [],
    }),
  ).rejects.toThrow("changed");
});

test("rejects unknown, relative, absent, or inaccessible local stores", async () => {
  const f = await local();
  for (const path of [undefined, "relative-store", join(root, "absent")]) {
    Object.defineProperty(f.backend, "localConversationStorageDir", {
      value: path,
      configurable: true,
    });
    await expect(
      capturePassiveContextSession(
        options(f.backend, f.agentId, f.conversationId),
      ),
    ).rejects.toThrow();
  }
  Object.defineProperty(f.backend, "localConversationStorageDir", {
    value: f.state,
  });
  await chmod(f.state, 0);
  try {
    await expect(
      capturePassiveContextSession(
        options(f.backend, f.agentId, f.conversationId),
      ),
    ).rejects.toThrow();
  } finally {
    await chmod(f.state, 0o700);
  }
});

test("requires explicit exact scope and an absolute private inbox directory", async () => {
  const f = await local();
  for (const change of [
    { agentId: " " },
    { conversationId: "" },
    { directory: "relative" },
  ]) {
    await expect(
      capturePassiveContextSession({
        ...options(f.backend, f.agentId, f.conversationId),
        ...change,
      }),
    ).rejects.toThrow();
  }
  const shared = join(root, "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  await expect(
    capturePassiveContextSession({
      ...options(f.backend, f.agentId, f.conversationId),
      directory: shared,
    }),
  ).rejects.toThrow();
});

function api() {
  let key = "first-private-key";
  let org: string | undefined = "org-one";
  const calls: { url: string; auth: string | null }[] = [];
  const client = new Letta({
    apiKey: key,
    baseURL: "https://passive.example",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(
        String(url).endsWith("/balance") ? { organization_id: org } : [],
      );
    },
  });
  Object.defineProperty(client, "apiKey", { get: () => key });
  const backend = new APIBackend({ getClient: async () => client });
  return {
    backend,
    client,
    calls,
    key(value: string) {
      key = value;
    },
    org(value?: string) {
      org = value;
    },
  };
}

test("API capture reuses matched SDK principal, key rotation preserves scope and uncertain records", async () => {
  const f = api();
  const opts = {
    ...options(f.backend, "agent-one", "default"),
    getClient: async () => f.client,
  };
  const first = await capturePassiveContextSession(opts);
  await first.inbox.record(input);
  await first.inbox.bindExplicitSubmission("human-one");
  await first.inbox.markDispatch("human-one");
  expect(f.calls).toHaveLength(1);
  expect(first.scope).toEqual({
    backend: "https://passive.example",
    account: "organization:org-one",
    agent: "agent-one",
    conversation: "default",
  });
  f.key("rotated-private-key");
  await expect(first.assertCurrent()).rejects.toThrow();
  const rotated = await capturePassiveContextSession(opts);
  expect(rotated.scope).toEqual(first.scope);
  expect((await rotated.inbox.getSubmission("human-one"))?.outcome).toBe(
    "uncertain",
  );
  f.key("other-account-private-key");
  f.org("org-two");
  const other = await capturePassiveContextSession(opts);
  expect(await other.inbox.list()).toEqual([]);
  expect((await first.inbox.getSubmission("human-one"))?.outcome).toBe(
    "uncertain",
  );
  await first.transport.listConversationMessages("default", {
    agent_id: "agent-one",
  });
  expect(f.calls.at(-1)?.auth).toBe("Bearer first-private-key");
  expect(JSON.stringify(first.scope)).not.toContain("private-key");
});

test("API unknown organization or unmatched injected owner fails closed", async () => {
  const f = api();
  await expect(
    capturePassiveContextSession(options(f.backend, "agent-one", "default")),
  ).rejects.toThrow();
  f.org();
  await expect(
    capturePassiveContextSession({
      ...options(f.backend, "agent-one", "default"),
      getClient: async () => f.client,
    }),
  ).rejects.toThrow();
});

test("captures caller scope/backend before awaits and refuses a replacement during capture", async () => {
  const f = await local();
  const opts = options(f.backend, f.agentId, f.conversationId);
  const pending = capturePassiveContextSession(opts);
  opts.agentId = "mutated-agent";
  opts.conversationId = "mutated-conversation";
  opts.directory = join(root, "mutated-inbox");
  const session = await pending;
  expect(session.scope.agent).toBe(f.agentId);
  expect(session.scope.conversation).toBe(f.conversationId);
  let backend: Backend = f.backend;
  const replaced = capturePassiveContextSession({
    ...options(backend, f.agentId, f.conversationId),
    getBackend: () => backend,
  });
  backend = new LocalBackend({
    storageDir: f.provider,
    stateStorageDir: f.state,
    memfsEnabled: false,
  });
  await expect(replaced).rejects.toThrow("changed");
});

test("inbox alias changes fail the current fence while recovery keeps its captured directory", async () => {
  const f = await local();
  const original = join(root, "original-inbox");
  const replacement = join(root, "other-inbox");
  const alias = join(root, "inbox-alias");
  await mkdir(original, { mode: 0o700 });
  await mkdir(replacement, { mode: 0o700 });
  await symlink(original, alias, "dir");
  const session = await capturePassiveContextSession({
    ...options(f.backend, f.agentId, f.conversationId),
    directory: alias,
  });
  await session.inbox.record(input);
  await rm(alias);
  await symlink(replacement, alias, "dir");
  await expect(session.assertCurrent()).rejects.toThrow("changed");
  expect(await session.inbox.list()).toHaveLength(1);
  const other = await capturePassiveContextSession({
    ...options(f.backend, f.agentId, f.conversationId),
    directory: alias,
  });
  expect(await other.inbox.list()).toEqual([]);
});
