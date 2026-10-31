import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import {
  clearSubagentsByIds,
  getSubagents,
  registerSubagent,
  registerSubagentAbortHook,
  updateSubagent,
} from "@/agent/subagent-state";
import type { TurnInterruptRequestResult } from "@/agent/turn-interrupt";
import { __testSetBackend } from "@/backend";
import {
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
import { settingsManager } from "@/settings-manager";
import {
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 7000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error(`Timed out: ${label}`);
}
class Output extends Writable {
  columns = 100;
  rows = 36;
  isTTY = true;
  frames: string[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ) {
    this.frames.push(stripAnsi(chunk.toString()));
    done();
  }
}
function approvalStream(
  ids: string[],
  companion = false,
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const id of companion ? ["companion", ...ids] : ids)
        yield {
          message_type: "approval_request_message",
          tool_call: {
            tool_call_id: id,
            name: id === "companion" ? "pause_companion" : "pause_tool",
            arguments: "{}",
          },
        };
      yield { message_type: "stop_reason", stop_reason: "requires_approval" };
    },
  } as unknown as Stream<LettaStreamingResponse>;
}
type State = {
  sessionActivation?: boolean;
  onRun?: () => void;
  stripApprovalInput?: boolean;
  early: boolean;
  hold?: Promise<void>;
  running: boolean;
  toolRuns: number;
  starts: ModTurnHandle[];
  ends: { id: string; reason: string }[];
  receipt?: TurnInterruptRequestResult;
};
const globals = globalThis as typeof globalThis & { __tuiRetirement?: State };
async function harness(executor: HeadlessTurnExecutor, state: State) {
  const home = process.env.HOME;
  const disabled = process.env.LETTA_DISABLE_MODS;
  const mode = resolveBackendMode();
  const root = mkdtempSync(join(tmpdir(), "tui-retirement-"));
  process.env.HOME = root;
  delete process.env.LETTA_DISABLE_MODS;
  setConfiguredBackendMode("local");
  clearPendingMessages();
  await settingsManager.reset();
  await settingsManager.initialize();
  globals.__tuiRetirement = state;
  const mods = join(root, ".letta", "mods");
  mkdirSync(mods, { recursive: true });
  writeFileSync(
    join(mods, "retirement.ts"),
    `export default function(letta){
  const state=globalThis.__tuiRetirement;state.sessionActivation=letta.capabilities.session?.activate;
  letta.events.on("turn_start",(event,ctx)=>{state.starts.push(ctx.turn);if(state.stripApprovalInput)return {input:event.input.filter(item=>item.type!=="approval")};});
  letta.events.on("turn_end",(event,ctx)=>{state.ends.push({id:ctx.turn.id,reason:event.stopReason});if(event.stopReason!=="end_turn")return {continue:"DO NOT SEND AFTER INTERRUPTION"};});
  letta.tools.register({name:"pause_tool",description:"Pause tool",approvalPolicy:"alwaysAsk",parameters:{type:"object",properties:{}},async run(){state.toolRuns++;state.running=true;state.onRun?.();if(state.hold)await state.hold;return "real tool output";}});
  letta.tools.register({name:"pause_companion",description:"Companion",approvalPolicy:"auto",parameters:{type:"object",properties:{}},run(ctx){if(state.early)state.receipt=ctx.turn.requestInterrupt("before UI registration");return "real companion";}});
 }`,
  );
  const agentId = "agent-local-turn-retirement";
  const backend = new FakeHeadlessBackend(agentId, executor);
  __testSetBackend(backend);
  const agentState = await backend.retrieveAgent(agentId);
  const conversation = await backend.createConversation({ agent_id: agentId });
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const output = new Output();
  const app = render(
    <App
      agentId={agentId}
      agentState={agentState}
      conversationId={conversation.id}
      systemInfoReminderEnabled={false}
    />,
    {
      stdin,
      stdout: output as Output & NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await waitFor(isQueueBridgeConnected, "TUI ready");
  await Bun.sleep(100);
  expect(state.sessionActivation).toBe(true);
  return {
    backend,
    stdin,
    frames: output.frames,
    async send(text: string) {
      await Bun.sleep(100);
      stdin.push(text);
      await Bun.sleep(30);
      stdin.push("\r");
    },
    async dispose() {
      app.unmount();
      app.cleanup();
      setMessageQueueAdder(null);
      clearPendingMessages();
      __testSetBackend(null);
      await settingsManager.reset();
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (disabled === undefined) delete process.env.LETTA_DISABLE_MODS;
      else process.env.LETTA_DISABLE_MODS = disabled;
      setConfiguredBackendMode(mode);
      delete globals.__tuiRetirement;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function state(early = false): State {
  return { early, running: false, toolRuns: 0, starts: [], ends: [] };
}

test.each([false, true])(
  "exact approval retirement before-registration=%s preserves recovery and emits cancelled once",
  async (early) => {
    const observed = state(early);
    const inputs: HeadlessTurnExecutorInput[] = [];
    const app = await harness(
      {
        async execute(input) {
          inputs.push(input);
          return inputs.length === 1
            ? approvalStream(["untouched"], true)
            : createAssistantMessageStream();
        },
      },
      observed,
    );
    try {
      await app.send("pause for approval");
      if (!early) {
        await waitFor(
          () => app.frames.some((frame) => frame.includes("Run pause_tool?")),
          "dialog",
        );
        observed.receipt = observed.starts[0]?.requestInterrupt("watcher");
      }
      await waitFor(() => !!observed.receipt, "request");
      const receipt = observed.receipt;
      if (receipt?.status !== "requested") throw new Error("missing receipt");
      expect((await receipt.wait(1500)).status).toBe("settled");
      expect(observed.ends).toEqual([
        { id: firstTurn(observed).id, reason: "cancelled" },
      ]);
      expect(observed.toolRuns).toBe(0);
      expect(inputs).toHaveLength(1);
      await app.send("legitimate recovery");
      await waitFor(
        () => inputs.length === 2 && observed.ends.length === 2,
        "recovery",
      );
      const body = JSON.stringify(inputs[1]?.body);
      expect(body).toContain("untouched");
      expect(body).toContain("real companion");
      expect(body).toContain("legitimate recovery");
      expect(observed.toolRuns).toBe(0);
      expect(observed.starts[0]?.requestInterrupt()).toEqual({
        status: "not-applied",
        reason: "stale-turn",
      });
    } finally {
      await app.dispose();
    }
  },
  20000,
);

test("aborted running tool emits terminal before physical settlement without reclassifying it as untouched", async () => {
  let release!: () => void;
  const observed = state();
  observed.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inputs: HeadlessTurnExecutorInput[] = [];
  const app = await harness(
    {
      async execute(input) {
        inputs.push(input);
        return approvalStream(["running"]);
      },
    },
    observed,
  );
  try {
    await app.send("run held tool");
    await waitFor(
      () => app.frames.some((frame) => frame.includes("Run pause_tool?")),
      "dialog",
    );
    app.stdin.push("\r");
    await waitFor(() => observed.running, "tool running");
    const receipt = observed.starts[0]?.requestInterrupt("lost turn");
    if (receipt?.status !== "requested") throw new Error("missing receipt");
    await waitFor(
      () => observed.ends.length === 1,
      "terminal during grace expiry",
    );
    expect(observed.ends[0]).toEqual({
      id: firstTurn(observed).id,
      reason: "cancelled",
    });
    expect(await receipt.wait(1)).toMatchObject({
      status: "incomplete",
      pending: expect.arrayContaining(["tools"]),
    });
    expect(inputs).toHaveLength(1);
    release();
    expect((await receipt.wait(1500)).status).toBe("settled");
    expect(observed.ends).toHaveLength(1);
  } finally {
    release();
    await app.dispose();
  }
}, 20000);

test("nested manual approval continuations emit one normal terminal with original identity", async () => {
  const observed = state();
  let calls = 0;
  const app = await harness(
    {
      async execute() {
        calls++;
        return calls <= 2
          ? approvalStream([`approval-${calls}`])
          : createAssistantMessageStream();
      },
    },
    observed,
  );
  try {
    await app.send("two approval stages");
    await waitFor(
      () => app.frames.some((frame) => frame.includes("Run pause_tool?")),
      "first dialog",
    );
    app.stdin.push("\r");
    await waitFor(() => calls === 2, "second turn step");
    await Bun.sleep(100);
    app.stdin.push("\r");
    await waitFor(() => observed.ends.length === 1, "normal terminal");
    expect(observed.toolRuns).toBe(2);
    expect(observed.starts).toHaveLength(1);
    expect(observed.ends).toEqual([
      { id: firstTurn(observed).id, reason: "end_turn" },
    ]);
  } finally {
    await app.dispose();
  }
}, 20000);

test("terminal backend error emits error once and ignores continuation", async () => {
  const observed = state();
  let calls = 0;
  const app = await harness(
    {
      async execute() {
        calls++;
        throw new Error("Invalid request: deliberate terminal fixture failure");
      },
    },
    observed,
  );
  try {
    await app.send("error fixture");
    await waitFor(() => observed.ends.length === 1, "error terminal");
    expect(observed.ends).toEqual([
      { id: firstTurn(observed).id, reason: "error" },
    ]);
    await Bun.sleep(50);
    expect(calls).toBe(1);
  } finally {
    await app.dispose();
  }
}, 20000);

test("native approved execution stops only its ticket-owned foreground child", async () => {
  let release!: () => void;
  const observed = state();
  observed.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stopped: string[] = [];
  const ids = ["native-owned", "native-background", "native-old"];
  observed.onRun = () => {
    const turn = observed.starts[0];
    if (!turn) throw new Error("missing turn");
    for (const id of ids) {
      registerSubagent(
        id,
        "test",
        "child",
        id === "native-old" ? "old-tool" : "running",
        id === "native-background",
        false,
        { agentId: turn.agentId, conversationId: turn.conversationId },
      );
      registerSubagentAbortHook(id, () => {
        stopped.push(id);
        updateSubagent(id, { cancelPending: undefined, status: "error" });
      });
    }
  };
  const app = await harness(
    {
      async execute() {
        return approvalStream(["running"]);
      },
    },
    observed,
  );
  try {
    await app.send("child ownership");
    await waitFor(
      () => app.frames.some((frame) => frame.includes("Run pause_tool?")),
      "dialog",
    );
    app.stdin.push("\r");
    await waitFor(() => observed.running, "tool");
    const receipt = observed.starts[0]?.requestInterrupt();
    if (receipt?.status !== "requested") throw new Error("missing receipt");
    expect(stopped).toEqual(["native-owned"]);
    expect(
      getSubagents()
        .filter((row) => ids.includes(row.id) && row.id !== "native-owned")
        .every((row) => row.status === "pending"),
    ).toBe(true);
    expect(await receipt.wait(1)).toMatchObject({
      status: "incomplete",
      pending: expect.arrayContaining(["tools", "children"]),
    });
    release();
    expect((await receipt.wait(1500)).status).toBe("settled");
  } finally {
    release();
    clearSubagentsByIds(ids);
    await app.dispose();
  }
}, 20000);

test("recovered approval input bypasses the no-model synthetic shortcut", async () => {
  const observed = state();
  const inputs: HeadlessTurnExecutorInput[] = [];
  const app = await harness(
    {
      async execute(input) {
        inputs.push(input);
        return inputs.length === 1
          ? approvalStream(["pending"], true)
          : createAssistantMessageStream();
      },
    },
    observed,
  );
  try {
    await app.send("pause");
    await waitFor(
      () => app.frames.some((frame) => frame.includes("Run pause_tool?")),
      "approval",
    );
    const turn = observed.starts[0];
    if (!turn) throw new Error("missing turn");
    const receipt = turn.requestInterrupt();
    if (receipt.status !== "requested") throw new Error("missing receipt");
    expect((await receipt.wait(1000)).status).toBe("settled");
    observed.stripApprovalInput = true;
    Object.defineProperty(app.backend, "capabilities", {
      value: { ...app.backend.capabilities, localModelCatalog: true },
    });
    app.backend.listModels = async () => [];
    await app.send("recover with no models");
    await waitFor(() => observed.ends.length === 2, "recovery terminal");
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs[1]?.body)).toContain("real companion");
  } finally {
    await app.dispose();
  }
}, 20000);

function firstTurn(observed: State): ModTurnHandle {
  const turn = observed.starts[0];
  if (!turn) throw new Error("Expected an observed logical turn");
  return turn;
}
