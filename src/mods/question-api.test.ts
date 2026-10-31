import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModCommandWithTimeout } from "@/cli/mods/command-runtime";
import { createModQuestionQueue } from "@/cli/mods/question-queue";
import { DEFAULT_MOD_CAPABILITIES } from "@/mods/capabilities";
import { createModConversationHandle } from "@/mods/conversation-handle";
import { createModEngine } from "@/mods/mod-engine";
import type { ModCommandContext, ModContext } from "@/mods/types";

function createModContext(): ModContext {
  return {
    app: { version: "test" },
    backgroundAgents: [],
    subagents: { list: () => [] },
    contextWindow: {
      currentUsage: null,
      remainingPercentage: null,
      size: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
    },
    cost: {
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalDurationMs: 0,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    cwd: "/tmp/project",
    lastRunId: null,
    memfs: { enabled: false, memoryDir: null },
    model: {
      displayName: "Sonnet",
      id: "model-1",
      provider: "anthropic",
      reasoningEffort: null,
    },
    networkPhase: null,
    permissionMode: "standard",
    reflection: { mode: null, stepCount: 0 },
    sessionId: "conversation-1",
    conversationSummary: null,
    systemPromptId: null,
    terminalWidth: 80,
    toolset: "default",
    agent: { id: "agent-1", name: "Amelia" },
    workspace: {
      cwd: "/tmp/project",
      currentDir: "/tmp/project",
      projectDir: "/tmp/project",
    },
  };
}

const questions = [
  {
    question: "Choose?",
    header: "Choice",
    options: [
      { label: "A", description: "First" },
      { label: "B", description: "Second" },
    ],
  },
];

async function setup(dialogs = true) {
  const root = mkdtempSync(join(tmpdir(), "mod-ask-"));
  writeFileSync(
    join(root, "ask.ts"),
    `export default function(letta) {
    letta.commands.register({ id: "ask", description: "Ask", async run() {
      const result = await letta.ui.ask({ questions: ${JSON.stringify(questions)} });
      return { type: "output", output: JSON.stringify(result) };
    }});
    letta.commands.register({ id: "late", description: "Late", async run() {
      await letta.ui.ask({ questions: ${JSON.stringify(questions)} });
      return { type: "output", output: JSON.stringify(await letta.ui.ask({ questions: ${JSON.stringify(questions)} })) };
    }});
    letta.commands.register({ id: "background", description: "Background", run() {
      void (async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        await letta.ui.ask({ questions: ${JSON.stringify(questions)} });
      })();
      return { type: "handled" };
    }});
    letta.events.on("conversation_open", async () => {
      await letta.ui.ask({ questions: ${JSON.stringify(questions)} });
    });
  }`,
  );
  const queue = createModQuestionQueue("agent-1", "conversation-1");
  const engine = createModEngine({
    globalModsDirectory: root,
    cacheDirectory: join(root, "cache"),
    capabilities: {
      ...DEFAULT_MOD_CAPABILITIES,
      ui: { panels: false, dialogs },
    },
    getClient: async () => {
      throw new Error("ask must not request inference/client");
    },
    onAsk: queue.ask,
    registerCapabilitiesGlobally: false,
  });
  await engine.reload();
  expect(engine.getSnapshot().diagnostics).toEqual([]);
  const command = engine.getSnapshot().commands.ask;
  if (!command) throw new Error("Expected registered ask command");
  const conversation = createModConversationHandle({
    agentId: "agent-1",
    conversationId: "conversation-1",
    sendMessageStream: async () => {
      throw new Error("ask must not send a conversation message");
    },
  });
  const context: ModCommandContext = {
    ...createModContext(),
    rawInput: "/ask",
    command: "ask",
    args: "",
    argv: [],
    conversation: { ...conversation, id: "conversation-1" },
  };
  return {
    engine,
    queue,
    command,
    context,
    cleanup() {
      engine.dispose();
      queue.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("real engine registered ask returns answers directly, without inference", async () => {
  const s = await setup();
  try {
    const pending = runModCommandWithTimeout(s.command, s.context);
    s.queue.getSnapshot()?.submit({ "Choose?": "B" });
    expect(await pending).toEqual({
      type: "output",
      output: JSON.stringify({
        status: "answered",
        answers: { "Choose?": "B" },
      }),
    });
    expect(s.queue.getSnapshot()).toBeNull();
  } finally {
    s.cleanup();
  }
});

test("disabled capability returns explicit unavailable without a pending question", async () => {
  const s = await setup(false);
  try {
    expect(await runModCommandWithTimeout(s.command, s.context)).toEqual({
      type: "output",
      output: JSON.stringify({ status: "dismissed", reason: "unavailable" }),
    });
    expect(s.queue.getSnapshot()).toBeNull();
  } finally {
    s.cleanup();
  }
});

test("reload and disposal cancel pending questions and stale registered commands cannot reopen them", async () => {
  for (const action of ["reload", "dispose"] as const) {
    const s = await setup();
    try {
      const pending = runModCommandWithTimeout(s.command, s.context);
      expect(s.queue.getSnapshot()).not.toBeNull();
      if (action === "reload") await s.engine.reload();
      else s.engine.dispose();
      expect(await pending).toEqual({
        type: "output",
        output: JSON.stringify({ status: "dismissed", reason: "cancelled" }),
      });
      expect(s.queue.getSnapshot()).toBeNull();
      await runModCommandWithTimeout(s.command, s.context);
      expect(s.queue.getSnapshot()).toBeNull();
    } finally {
      s.cleanup();
    }
  }
});

test("command timeout aborts current and subsequent questions from its still-running handler", async () => {
  const s = await setup();
  try {
    const pending = runModCommandWithTimeout(
      requireLateCommand(s.engine),
      s.context,
      5,
    );
    expect(s.queue.getSnapshot()).not.toBeNull();
    await expect(pending).rejects.toThrow("timed out");
    expect(s.queue.getSnapshot()).toBeNull();
  } finally {
    s.cleanup();
  }
});

test("ask outside invocation is unavailable; events capture their own agent/conversation identity", async () => {
  const s = await setup();
  try {
    expect(await s.command.run(s.context)).toEqual({
      type: "output",
      output: JSON.stringify({ status: "dismissed", reason: "unavailable" }),
    });
    s.queue.setScope("event-agent", "event-conversation");
    const pending = s.engine.emitEvent(
      "conversation_open",
      {
        agentId: "event-agent",
        agentName: "Event",
        conversationId: "event-conversation",
        reason: "startup",
      },
      s.context,
    );
    expect(s.queue.getSnapshot()?.request).toMatchObject({
      agentId: "event-agent",
      conversationId: "event-conversation",
      owner: { generation: 1 },
    });
    s.queue.getSnapshot()?.dismiss();
    expect((await pending).diagnostics).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("invocation abort dismisses a real registered command without delivery", async () => {
  const s = await setup();
  try {
    const controller = new AbortController();
    const pending = runModCommandWithTimeout(s.command, {
      ...s.context,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({
      type: "output",
      output: JSON.stringify({ status: "dismissed", reason: "cancelled" }),
    });
    expect(s.queue.getSnapshot()).toBeNull();
  } finally {
    s.cleanup();
  }
});

function requireLateCommand(engine: ReturnType<typeof createModEngine>) {
  const command = engine.getSnapshot().commands.late;
  if (!command) throw new Error("Expected late command");
  return command;
}

test("null event scope retains existing context fallback", async () => {
  const s = await setup();
  try {
    const pending = s.engine.emitEvent(
      "conversation_open",
      {
        agentId: null,
        agentName: null,
        conversationId: null,
        reason: "startup",
      },
      s.context,
    );
    expect(s.queue.getSnapshot()?.request).toMatchObject({
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
    s.queue.getSnapshot()?.dismiss();
    expect((await pending).diagnostics).toEqual([]);
  } finally {
    s.cleanup();
  }
});

test("engine does not advertise dialogs without a host, even if configured true", () => {
  const engine = createModEngine({
    getClient: async () => {
      throw new Error("unused");
    },
    capabilities: {
      ...DEFAULT_MOD_CAPABILITIES,
      ui: { panels: false, dialogs: true },
    },
    includeGlobalMods: false,
  });
  try {
    expect(engine.getSnapshot().capabilities.ui.dialogs).toBe(false);
  } finally {
    engine.dispose();
  }
});

test("successful handled commands retain async invocation scope for owned background questions", async () => {
  const s = await setup();
  try {
    const command = s.engine.getSnapshot().commands.background;
    if (!command) throw new Error("Expected background command");
    expect(await runModCommandWithTimeout(command, s.context)).toEqual({
      type: "handled",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.queue.getSnapshot()?.request).toMatchObject({
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
    await s.engine.reload();
    expect(s.queue.getSnapshot()).toBeNull();
  } finally {
    s.cleanup();
  }
});

test("command asks capture the exact conversation handle, even if ambient session lags", async () => {
  const s = await setup();
  try {
    const pending = runModCommandWithTimeout(s.command, {
      ...s.context,
      sessionId: "old-ambient-session",
    });
    expect(s.queue.getSnapshot()?.request.conversationId).toBe(
      "conversation-1",
    );
    s.queue.getSnapshot()?.dismiss();
    expect((await pending).type).toBe("output");
  } finally {
    s.cleanup();
  }
});

test("agent and conversation switches cancel real engine requests", async () => {
  for (const changeAgent of [false, true]) {
    const s = await setup();
    try {
      const pending = runModCommandWithTimeout(s.command, s.context);
      s.queue.setScope(
        changeAgent ? "agent-2" : "agent-1",
        changeAgent ? "conversation-1" : "conversation-2",
      );
      expect(await pending).toEqual({
        type: "output",
        output: JSON.stringify({
          status: "dismissed",
          reason: "scope-changed",
        }),
      });
      expect(s.queue.getSnapshot()).toBeNull();
    } finally {
      s.cleanup();
    }
  }
});
