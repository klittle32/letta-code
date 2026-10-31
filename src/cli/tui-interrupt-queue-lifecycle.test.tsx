/**
 * Regression tests for the TUI interrupt -> queue handoff (issue #4168).
 *
 * A Monitor `task_notification` queued while a turn is active must start the
 * next turn on its own once an Esc cancellation has settled. The interrupted
 * turn's finally block owns that `cancelling -> idle` transition and wakes the
 * dequeue effect; no timer or later user prompt may be required.
 *
 * The typed-prompt case matters: a turn started from the queue bridge is woken
 * by the dequeue effect's own completion callback, which masked the bug. A
 * turn started by typing has no such callback.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { type Instance, render } from "ink";
import stripAnsi from "strip-ansi";
import { WebSocketServer } from "ws";
import type { TurnInterruptRequestResult } from "@/agent/turn-interrupt";
import { __testSetBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { App } from "@/cli/App";
import type { ModTurnHandle } from "@/mods/types";
import { permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";
import { settingsManager } from "@/settings-manager";
import { monitor } from "@/tools/impl/monitor";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";

class TuiOutputStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(chunk.toString());
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(10);
  }
  if (!predicate()) {
    throw new Error(`Timed out waiting for ${description}`);
  }
}

function monitorNotification(summary: string): string {
  return formatTaskNotification({
    taskId: "monitor-test",
    status: "completed",
    summary,
    result: "done",
    outputFile: "/tmp/monitor-test.log",
  });
}

/**
 * First turn: a stream that yields nothing until aborted, then ends only when
 * the test releases it (so the test controls when cancellation settles).
 * Every later turn: an immediate assistant reply.
 */
class DelayedInterruptExecutor implements HeadlessTurnExecutor {
  readonly inputs: HeadlessTurnExecutorInput[] = [];
  private releaseInterruptedTurn: (() => void) | null = null;
  private readonly interruptedTurnReleased = new Promise<void>((resolve) => {
    this.releaseInterruptedTurn = resolve;
  });
  private resolveAbortObserved: (() => void) | null = null;
  readonly abortObserved = new Promise<void>((resolve) => {
    this.resolveAbortObserved = resolve;
  });

  async execute(input: HeadlessTurnExecutorInput) {
    this.inputs.push(input);
    if (this.inputs.length > 1) {
      return createAssistantMessageStream();
    }

    const controller = new AbortController();
    const abortObserved = this.resolveAbortObserved;
    const interruptedTurnReleased = this.interruptedTurnReleased;
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        abortObserved?.();
        await interruptedTurnReleased;
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }

  settleInterruptedTurn(): void {
    this.releaseInterruptedTurn?.();
    this.releaseInterruptedTurn = null;
  }
}

const monitorSources = new Set<WebSocketServer>();
const monitorIds = new Set<string>();

async function startMonitor(scope: {
  agentId: string;
  conversationId: string;
}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  monitorSources.add(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing socket address");
  const connected = new Promise<import("ws").WebSocket>((resolve) =>
    server.once("connection", resolve),
  );
  const result = await monitor({
    description: "Watch interrupt fixture events",
    ws: { url: `ws://127.0.0.1:${address.port}` },
    persistent: true,
    parentScope: scope,
  });
  monitorIds.add(result.taskId);
  const socket = await connected;
  const state = backgroundProcesses.get(result.taskId);
  if (!state) throw new Error("Monitor was not registered");
  let closed = false;
  socket.once("close", () => {
    closed = true;
  });
  return { socket, state, isClosed: () => closed };
}

const renderedInstances = new Set<Instance>();
let previousBackendMode: BackendMode;
let previousHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  clearPendingMessages();
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-tui-interrupt-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  for (const instance of renderedInstances) {
    instance.unmount();
    instance.cleanup();
  }
  renderedInstances.clear();
  for (const id of monitorIds) {
    const state = backgroundProcesses.get(id);
    if (state) {
      state.completionNotificationSuppressed = true;
      state.process.kill();
    }
    clearBackgroundProcessCleanup(id);
    backgroundProcesses.delete(id);
  }
  monitorIds.clear();
  for (const server of monitorSources) {
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
  monitorSources.clear();
  setMessageQueueAdder(null);
  clearPendingMessages();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  await settingsManager.reset();
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

async function renderTestApp(
  executor: HeadlessTurnExecutor,
  enableMods = false,
): Promise<{
  backend: FakeHeadlessBackend;
  stdin: NodeJS.ReadStream;
  frames: string[];
}> {
  // This fixture is local. A Cloud-shaped ID makes skill discovery query
  // attached repositories over HTTP before each otherwise-fake turn.
  const agentId = "agent-local-tui-interrupt-queue";
  const backend = new FakeHeadlessBackend(agentId, executor);
  __testSetBackend(backend);
  const agentState = await backend.retrieveAgent(agentId);
  const conversation = await backend.createConversation({ agent_id: agentId });
  const stdin = createInputStream();
  const stdout = new TuiOutputStream() as TuiOutputStream & NodeJS.WriteStream;
  const instance = render(
    <App
      agentId={agentId}
      agentState={agentState}
      conversationId={conversation.id}
      modsDisabled={!enableMods}
      systemInfoReminderEnabled={false}
    />,
    {
      stdout,
      stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  renderedInstances.add(instance);
  await waitFor(isQueueBridgeConnected, "the TUI queue bridge to mount");
  return { backend, stdin, frames: stdout.chunks };
}

async function typePrompt(stdin: NodeJS.ReadStream, text: string) {
  // Give the input component a moment to mount before typing.
  await sleep(200);
  stdin.push(text);
  await sleep(50);
  stdin.push("\r");
}

describe("TUI interrupt queue lifecycle", () => {
  test("a real Monitor survives normal completion and idle Esc", async () => {
    const inputs: HeadlessTurnExecutorInput[] = [];
    const { stdin } = await renderTestApp({
      async execute(input) {
        inputs.push(input);
        return createAssistantMessageStream();
      },
    });
    await typePrompt(stdin, "complete normally");
    await waitFor(() => inputs.length === 1, "the normal turn");
    const input = inputs[0];
    if (!input) throw new Error("Missing first turn");
    const source = await startMonitor(input);
    // An event drives another complete turn while the source stays connected.
    source.socket.send("normal monitor event");
    await waitFor(
      () =>
        readFileSync(source.state.outputFile as string, "utf8").includes(
          "normal monitor event",
        ),
      "the normal Monitor event to be received",
    );
    // Receipt and TUI delivery are separate stages. On Windows the 200 ms
    // Monitor batch plus Ink dequeue can exceed the generic fixture deadline.
    await waitFor(
      () => inputs.length === 2,
      "the Monitor notification turn",
      10_000,
    );
    await sleep(300);
    expect(source.state.status).toBe("running");
    stdin.push("\u001b");
    await sleep(100);
    expect(source.isClosed()).toBe(false);
    source.socket.send("still watching after idle Esc");
    await waitFor(
      () => inputs.length === 3,
      "the event after idle Esc",
      10_000,
    );
    expect(JSON.stringify(inputs[2]?.body)).toContain(
      "still watching after idle Esc",
    );
    expect(JSON.stringify(inputs[2]?.body)).not.toContain(
      "Any pending monitors",
    );
    expect(source.state.status).toBe("running");
  }, 30_000);

  test("an idle Monitor notification starts an agent turn without user input", async () => {
    const executor = new DelayedInterruptExecutor();
    await renderTestApp(executor);

    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("idle monitor completion"),
    });

    await waitFor(() => executor.inputs.length === 1, "the notification turn");
    expect(JSON.stringify(executor.inputs[0]?.body)).toContain(
      "idle monitor completion",
    );
    executor.settleInterruptedTurn();
  });

  test("typed prompt, notification queued, Esc: the Monitor survives and notifications drain after cancellation", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);

    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");

    const input = executor.inputs[0];
    if (!input) throw new Error("Missing first turn");
    const source = await startMonitor(input);
    source.socket.send("queued before Esc");
    await waitFor(
      () =>
        readFileSync(source.state.outputFile as string, "utf8").includes(
          "queued before Esc",
        ),
      "the real Monitor event to be received",
    );
    // Monitor batches events for 200ms before handing them to the TUI queue.
    await sleep(300);
    stdin.push("\u001b");
    await executor.abortObserved;
    expect(source.isClosed()).toBe(false);
    expect(source.state.status).toBe("running");

    // Cancellation has not settled yet: nothing may start a replacement turn.
    await sleep(100);
    expect(executor.inputs).toHaveLength(1);

    executor.settleInterruptedTurn();
    await waitFor(
      () => executor.inputs.length === 2,
      "the queued notification turn after cancellation settled",
    );
    const nextTurn = JSON.stringify(executor.inputs[1]?.body);
    expect(nextTurn).toContain("queued before Esc");
    expect(nextTurn).not.toContain("Any pending monitors");

    source.socket.send("still watching after active Esc");
    await waitFor(
      () => executor.inputs.length === 3,
      "the Monitor event after active Esc",
    );
    expect(JSON.stringify(executor.inputs[2]?.body)).toContain(
      "still watching after active Esc",
    );
    expect(source.state.status).toBe("running");
  }, 15_000);

  test("typed prompt, Esc, then a notification that arrives after cancellation settled", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);

    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");

    stdin.push("\u001b");
    await executor.abortObserved;
    executor.settleInterruptedTurn();
    await sleep(200);

    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("arrived after Esc"),
    });
    await waitFor(
      () => executor.inputs.length === 2,
      "the notification turn after an already-settled Esc",
    );
    expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
      "arrived after Esc",
    );
  }, 15_000);

  test("a second Esc while the interrupt unwinds re-fires the backend cancel", async () => {
    const executor = new DelayedInterruptExecutor();
    const { backend, stdin } = await renderTestApp(executor);
    const cancelCalls: string[] = [];
    const originalCancel = backend.cancelConversation.bind(backend);
    backend.cancelConversation = async (conversationId: string) => {
      cancelCalls.push(conversationId);
      return originalCancel(conversationId);
    };

    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");

    stdin.push("\u001b");
    await executor.abortObserved;
    await waitFor(() => cancelCalls.length === 1, "the first backend cancel");

    // The interrupted turn is still unwinding (the executor holds its
    // stream). A second Esc must escalate: re-fire the backend cancel
    // instead of silently returning, so a lost first attempt is retried.
    stdin.push("\u001b");
    await waitFor(
      () => cancelCalls.length === 2,
      "the escalated backend cancel",
    );

    // The escalation force-settles the interrupt, but the executor still
    // holds the turn. A third Esc must keep routing to the handler (the
    // aborted controller witnesses the in-flight interrupt) and re-fire
    // the cancel again, so the retry route survives the settle.
    stdin.push("\u001b");
    await waitFor(
      () => cancelCalls.length === 3,
      "the post-settle retry cancel",
    );

    executor.settleInterruptedTurn();
  }, 15_000);

  test("a failed backend cancel is surfaced and a second Esc retries it", async () => {
    const executor = new DelayedInterruptExecutor();
    const { backend, stdin, frames } = await renderTestApp(executor);
    let cancelAttempts = 0;
    const originalCancel = backend.cancelConversation.bind(backend);
    backend.cancelConversation = async (conversationId: string) => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) throw new Error("network down");
      return originalCancel(conversationId);
    };

    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");

    stdin.push("\u001b");
    await executor.abortObserved;
    await waitFor(() => cancelAttempts === 1, "the failed backend cancel");
    await waitFor(
      () =>
        frames.some((frame) =>
          stripAnsi(frame).includes("backend cancel request failed"),
        ),
      "the surfaced cancel failure",
    );

    // The interrupt is still unwinding; a second Esc must retry the cancel.
    stdin.push("\u001b");
    await waitFor(() => cancelAttempts === 2, "the retried backend cancel");

    executor.settleInterruptedTurn();
  }, 15_000);

  test.each(["Enter", "new message", "cron event"])(
    "Esc parks a user message; a notification still drains; %s resumes",
    async (resumeWith) => {
      const executor = new DelayedInterruptExecutor();
      const { stdin } = await renderTestApp(executor);

      await typePrompt(stdin, "start turn");
      await waitFor(
        () => executor.inputs.length === 1,
        "the typed initial turn",
      );
      // A user message queued behind the active turn (source: user).
      addToMessageQueue({ kind: "user", text: "queued while busy" });

      addToMessageQueue(
        resumeWith === "cron event"
          ? { kind: "user", source: "cron", text: "scheduled event" }
          : {
              kind: "task_notification",
              text: monitorNotification("arrived during turn"),
            },
      );
      stdin.push("\u001b");
      await executor.abortObserved;
      executor.settleInterruptedTurn();

      // The notification starts a turn on its own; the parked user message does not.
      await waitFor(
        () => executor.inputs.length === 2,
        "the notification turn after Esc",
      );
      const notificationTurn = JSON.stringify(executor.inputs[1]?.body);
      expect(notificationTurn).toContain(
        resumeWith === "cron event" ? "scheduled event" : "arrived during turn",
      );
      expect(notificationTurn).not.toContain("queued while busy");
      await sleep(300);
      expect(executor.inputs).toHaveLength(2);

      if (resumeWith !== "new message") {
        stdin.push("\r");
      } else {
        await typePrompt(stdin, "sent after interrupt");
      }
      await waitFor(
        () => executor.inputs.length === 3,
        "the parked message to run after resuming",
      );
      expect(JSON.stringify(executor.inputs[2]?.body)).toContain(
        "queued while busy",
      );
      if (resumeWith === "new message") {
        await waitFor(
          () =>
            JSON.stringify(executor.inputs.slice(2)).includes(
              "sent after interrupt",
            ),
          "the new message to reach the backend",
        );
        const resumed = JSON.stringify(executor.inputs.slice(2));
        expect(resumed.indexOf("queued while busy")).toBeLessThan(
          resumed.indexOf("sent after interrupt"),
        );
      }
    },
    20_000,
  );
});

test("real TUI mod requests before streaming, then cannot target the next turn", async () => {
  const state: {
    handles: ModTurnHandle[];
    receipt?: TurnInterruptRequestResult;
    loaded: boolean;
  } = { handles: [], loaded: false };
  const testGlobal = globalThis as typeof globalThis & {
    __exactTurnTest?: typeof state;
  };
  const disabledMods = process.env.LETTA_DISABLE_MODS;
  delete process.env.LETTA_DISABLE_MODS;
  testGlobal.__exactTurnTest = state;
  const modDir = join(tempHome, ".letta", "mods");
  mkdirSync(modDir, { recursive: true });
  writeFileSync(
    join(modDir, "exact-turn.ts"),
    `export default function(letta) {
    globalThis.__exactTurnTest.loaded = true;
    letta.events.on("turn_start", async (_event, ctx) => {
      const state = globalThis.__exactTurnTest;
      state.handles.push(ctx.turn);
      if (state.handles.length === 1) state.receipt = ctx.turn.requestInterrupt("watcher superseded");
    });
  }`,
  );
  const inputs: HeadlessTurnExecutorInput[] = [];
  try {
    const { stdin } = await renderTestApp(
      {
        async execute(input) {
          inputs.push(input);
          return createAssistantMessageStream();
        },
      },
      true,
    );
    await waitFor(() => state.loaded, "the exact-turn mod to load");
    await typePrompt(stdin, "first request is interrupted by hook");
    await waitFor(() => !!state.receipt, "the synchronous request receipt");
    if (state.receipt?.status !== "requested")
      throw new Error("missing requested receipt");
    expect(await state.receipt.wait(1000)).toMatchObject({ status: "settled" });
    expect(inputs).toHaveLength(0);
    await typePrompt(stdin, "second request completes");
    await waitFor(() => inputs.length === 1, "the second turn");
    expect(state.handles).toHaveLength(2);
    expect(state.handles[0]?.id).not.toBe(state.handles[1]?.id);
    expect(state.handles[0]?.requestInterrupt()).toEqual({
      status: "not-applied",
      reason: "stale-turn",
    });
  } finally {
    delete testGlobal.__exactTurnTest;
    if (disabledMods === undefined) delete process.env.LETTA_DISABLE_MODS;
    else process.env.LETTA_DISABLE_MODS = disabledMods;
  }
}, 15000);

test("real TUI watcher cancels only the observed backend run and reports rejection", async () => {
  const state: { handle?: ModTurnHandle; loaded: boolean } = { loaded: false };
  const scope = globalThis as typeof globalThis & {
    __exactWatcherTest?: typeof state;
  };
  scope.__exactWatcherTest = state;
  const disabledMods = process.env.LETTA_DISABLE_MODS;
  delete process.env.LETTA_DISABLE_MODS;
  const modDir = join(tempHome, ".letta", "mods");
  mkdirSync(modDir, { recursive: true });
  writeFileSync(
    join(modDir, "watcher.ts"),
    `export default function(letta) {
    globalThis.__exactWatcherTest.loaded = true;
    letta.events.on("turn_start", (_event,ctx) => { globalThis.__exactWatcherTest.handle = ctx.turn; });
  }`,
  );
  let yielded = false;
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  try {
    const { backend, stdin } = await renderTestApp(
      {
        async execute() {
          return {
            controller,
            async *[Symbol.asyncIterator]() {
              yield {
                message_type: "assistant_message",
                id: "msg-exact",
                content: "working",
              };
              yielded = true;
              await done;
            },
          } as unknown as Stream<LettaStreamingResponse>;
        },
      },
      true,
    );
    const exact: string[] = [];
    let broad = 0;
    backend.cancelRun = async (_agentId, runId) => {
      exact.push(runId);
      throw new Error("exact cancellation rejected");
    };
    backend.cancelConversation = async () => {
      broad++;
      throw new Error("must not widen");
    };
    await waitFor(() => state.loaded, "watcher mod loaded");
    await typePrompt(stdin, "stream with an exact run");
    await waitFor(() => yielded, "observed run chunk");
    const receipt = state.handle?.requestInterrupt("watcher event");
    if (receipt?.status !== "requested")
      throw new Error("missing watcher receipt");
    release();
    const outcome = await receipt.wait(1000);
    expect(exact).toHaveLength(1);
    expect(outcome).toMatchObject({
      status: "incomplete",
      errors: [{ resource: "backend", message: "exact cancellation rejected" }],
    });
    expect(broad).toBe(0);
  } finally {
    release();
    delete scope.__exactWatcherTest;
    if (disabledMods === undefined) delete process.env.LETTA_DISABLE_MODS;
    else process.env.LETTA_DISABLE_MODS = disabledMods;
  }
}, 15000);

test("mod interrupt during approved tool preserves queued input and real tool results", async () => {
  let release!: () => void;
  const toolDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state: {
    loaded: boolean;
    started: boolean;
    handle?: ModTurnHandle;
    finish: () => Promise<void>;
  } = { loaded: false, started: false, finish: () => toolDone };
  const scope = globalThis as typeof globalThis & {
    __approvedInterruptTest?: typeof state;
  };
  scope.__approvedInterruptTest = state;
  const disabledMods = process.env.LETTA_DISABLE_MODS;
  delete process.env.LETTA_DISABLE_MODS;
  const modDir = join(tempHome, ".letta", "mods");
  mkdirSync(modDir, { recursive: true });
  writeFileSync(
    join(modDir, "approved-interrupt.ts"),
    `export default function(letta){
    const state=globalThis.__approvedInterruptTest;
    state.loaded=true;
    letta.events.on("turn_start",(_event,ctx)=>{state.handle=ctx.turn;});
    letta.tools.register({name:"held_approval_tool",description:"Held approval regression",approvalPolicy:"alwaysAsk",parameters:{type:"object",properties:{}},async run(){state.started=true;await state.finish();return "actual-tool-completed";}});
  }`,
  );
  const inputs: HeadlessTurnExecutorInput[] = [];
  try {
    const { backend, stdin, frames } = await renderTestApp(
      {
        async execute(input) {
          inputs.push(input);
          if (inputs.length > 1) return createAssistantMessageStream();
          return {
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              yield {
                message_type: "approval_request_message",
                tool_call: {
                  tool_call_id: "held-call",
                  name: "held_approval_tool",
                  arguments: "{}",
                },
              };
              yield {
                message_type: "stop_reason",
                stop_reason: "requires_approval",
              };
            },
          } as unknown as Stream<LettaStreamingResponse>;
        },
      },
      true,
    );
    const cancelledRunIds: string[] = [];
    const cancelRun = backend.cancelRun.bind(backend);
    backend.cancelRun = async (agentId, runId) => {
      cancelledRunIds.push(runId);
      return cancelRun(agentId, runId);
    };
    await waitFor(() => state.loaded, "approval mod loaded");
    await typePrompt(stdin, "request a manually approved tool");
    await waitFor(
      () =>
        frames.some((frame) =>
          stripAnsi(frame).includes("Run held_approval_tool?"),
        ),
      "manual approval dialog",
    );
    stdin.push("\r");
    await waitFor(() => state.started, "approved tool execution");
    addToMessageQueue({ kind: "user", text: "preserve this queued input" });
    await sleep(30);
    const receipt = state.handle?.requestInterrupt("superseded during tool");
    expect(receipt?.status).toBe("requested");
    release();
    await waitFor(
      () => inputs.length > 1,
      "queued input and tool results sent after cancellation",
    );
    const continuation = JSON.stringify(
      inputs.slice(1).map((input) => input.body),
    );
    expect(continuation).toContain("preserve this queued input");
    expect(continuation).toContain("actual-tool-completed");
    expect(continuation).toContain("held-call");
    expect(cancelledRunIds).toHaveLength(1);
    if (receipt?.status !== "requested") throw new Error("missing receipt");
    expect((await receipt.wait(1000)).status).toBe("incomplete");
  } finally {
    release();
    delete scope.__approvedInterruptTest;
    if (disabledMods === undefined) delete process.env.LETTA_DISABLE_MODS;
    else process.env.LETTA_DISABLE_MODS = disabledMods;
  }
}, 15000);

test.each(["normal", "fast", "grace-expired"])(
  "approve-always %s interruption preserves partials, companions, and queued input",
  async (timing) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const name = `allowed_batch_${timing.replaceAll("-", "_")}`;
    const state = {
      name,
      loaded: false,
      started: 0,
      handle: undefined as ModTurnHandle | undefined,
      finish: () => held,
    };
    const scope = globalThis as typeof globalThis & {
      __alwaysInterruptTest?: typeof state;
    };
    scope.__alwaysInterruptTest = state;
    const disabledMods = process.env.LETTA_DISABLE_MODS;
    const previousMode = permissionMode.getMode();
    permissionMode.setMode("standard");
    const previousRules = sessionPermissions.getRules();
    sessionPermissions.clear();
    delete process.env.LETTA_DISABLE_MODS;
    const modDir = join(tempHome, ".letta", "mods");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
      join(modDir, "always-interrupt.ts"),
      `export default function(letta) {
    const state = globalThis.__alwaysInterruptTest;
    letta.events.on("turn_start", (_event,ctx) => { state.handle=ctx.turn; });
    letta.tools.register({name:state.name,description:"Approve batch",approvalPolicy:"ask",parallelSafe:true,parameters:{type:"object",properties:{index:{type:"number"}}},async run(ctx) {
      state.started++;
      if(ctx.args.index===2) await state.finish();
      return "actual-result-"+ctx.args.index;
    }});
    letta.tools.register({name:"batch_companion",description:"Companion",approvalPolicy:"auto",parameters:{type:"object",properties:{}},run(){return "companion-completed";}});
    state.loaded=true;
  }`,
    );
    const inputs: HeadlessTurnExecutorInput[] = [];
    try {
      const { stdin, frames } = await renderTestApp(
        {
          async execute(input) {
            inputs.push(input);
            if (inputs.length > 1) return createAssistantMessageStream();
            return {
              controller: new AbortController(),
              async *[Symbol.asyncIterator]() {
                for (const index of [0, 1, 2])
                  yield {
                    message_type: "approval_request_message",
                    tool_call: {
                      tool_call_id: `batch-call-${index}`,
                      name: index === 0 ? "batch_companion" : name,
                      arguments: JSON.stringify({ index }),
                    },
                  };
                yield {
                  message_type: "stop_reason",
                  stop_reason: "requires_approval",
                };
              },
            } as unknown as Stream<LettaStreamingResponse>;
          },
        },
        true,
      );
      await waitFor(() => state.loaded, "approve-always mod loaded");
      await typePrompt(stdin, "request two approvals and a companion");
      await waitFor(
        () => frames.some((frame) => stripAnsi(frame).includes(`Run ${name}?`)),
        "approve-always option",
      );
      stdin.push("2");
      await waitFor(
        () => state.started === 2,
        "both newly allowed tools running",
      );
      expect(sessionPermissions.hasRule(name, "allow")).toBe(true);
      addToMessageQueue({ kind: "user", text: "queued after always-allow" });
      await sleep(30);
      const receipt =
        timing === "normal"
          ? undefined
          : state.handle?.requestInterrupt("stop allowed batch");
      if (timing !== "normal" && receipt?.status !== "requested")
        throw new Error("missing interrupt receipt");
      if (timing !== "grace-expired") release();
      await waitFor(
        () => inputs.length > 1,
        "saved batch results sent with queued input",
      );
      const continuation = JSON.stringify(
        inputs.slice(1).map((input) => input.body),
      );
      expect(continuation).toContain("queued after always-allow");
      expect(continuation).toContain("actual-result-1");
      expect(continuation).toContain("companion-completed");
      expect(continuation).toContain("batch-call-0");
      expect(continuation).toContain("batch-call-1");
      if (timing !== "grace-expired") {
        expect(continuation).toContain("actual-result-2");
        expect(continuation).toContain("batch-call-2");
      } else {
        expect(continuation).not.toContain("actual-result-2");
        if (receipt?.status !== "requested") throw new Error("missing receipt");
        const pending = await receipt.wait(1);
        if (pending.status !== "incomplete")
          throw new Error("unsettled tool claimed stopped");
        expect(pending.pending).toContain("tools");
        release();
      }
      if (receipt?.status === "requested") await receipt.wait(1000);
    } finally {
      release();
      delete scope.__alwaysInterruptTest;
      permissionMode.setMode(previousMode);
      sessionPermissions.clear();
      for (const kind of ["allow", "deny", "ask", "alwaysAsk"] as const)
        for (const rule of previousRules[kind] ?? [])
          sessionPermissions.addRule(rule, kind);
      if (disabledMods === undefined) delete process.env.LETTA_DISABLE_MODS;
      else process.env.LETTA_DISABLE_MODS = disabledMods;
    }
  },
  15000,
);
