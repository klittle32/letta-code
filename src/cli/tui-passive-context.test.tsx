import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { render } from "ink";
import { __testSetBackend } from "@/backend/backend";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { createAssistantMessageStream } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { App } from "@/cli/App";
import type { ModContextRecords } from "@/mods/context-records-api";
import { settingsManager } from "@/settings-manager";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import {
  restoreAmbientLettaTestEnv,
  snapshotAmbientLettaTestEnv,
  stripAmbientLettaTestEnv,
} from "@/test-utils/test-process-env";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

setupRuntimeModelCatalogFixture();
let failureOutput: (() => string) | undefined;
async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 7000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate())
    throw new Error(
      `Timed out: ${label}\nTUI output: ${failureOutput?.() ?? "unavailable"}`,
    );
}
class Output extends Writable {
  frames: string[] = [];
  columns = 100;
  rows = 36;
  isTTY = true;
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ) {
    this.frames.push(chunk.toString());
    done();
  }
}

test.each([
  "user",
  "cron",
  "task_notification",
  "conflict",
  "transient",
  "approval-conflict",
  "esc",
] as const)(
  "rendered TUI passive record and queued %s after real mod tool",
  async (queuedKind) => {
    const root = mkdtempSync(join(tmpdir(), "tui-passive-"));
    const keys = [
      "LETTA_CONFIG_DIR",
      "USER_CWD",
      "LETTA_DISABLE_MODS",
    ] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);
    const mode = resolveBackendMode();
    const ambient = snapshotAmbientLettaTestEnv();
    const openaiKey = process.env.OPENAI_API_KEY;
    stripAmbientLettaTestEnv(process.env);
    process.env.OPENAI_API_KEY = "fixture-no-provider-network";
    const state = globalThis as typeof globalThis & {
      __passiveRecords?: ModContextRecords;
      __passiveRecorded?: boolean;
      __passiveEnded?: boolean;
      __passiveEnqueue?: () => void;
    };
    let app: ReturnType<typeof render> | undefined;
    try {
      process.env.LETTA_CONFIG_DIR = join(root, "config");
      process.env.USER_CWD = root;
      delete process.env.LETTA_DISABLE_MODS;
      setConfiguredBackendMode("local");
      clearPendingMessages();
      await settingsManager.reset();
      await settingsManager.initialize();
      const store = join(root, "state");
      mkdirSync(store);
      let executions = 0;
      const backend = new LocalBackend({
        storageDir: join(root, "provider"),
        stateStorageDir: store,
        memfsEnabled: false,
        executor: {
          async execute() {
            if (++executions > 1 || queuedKind === "esc")
              return createAssistantMessageStream();
            return {
              controller: new AbortController(),
              async *[Symbol.asyncIterator]() {
                yield {
                  message_type: "approval_request_message",
                  tool_call: {
                    tool_call_id: "passive-tool",
                    name: "context_tool",
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
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Passive TUI",
        model: "openai/gpt-5.6-luna",
      });
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      });
      state.__passiveEnqueue = () =>
        addToMessageQueue({
          kind:
            queuedKind === "task_notification" ? "task_notification" : "user",
          ...(queuedKind === "cron" ? { source: "cron" as const } : {}),
          text:
            queuedKind === "task_notification"
              ? "<task-notification>Automated completion</task-notification>"
              : "Queued input after tool",
          agentId: agent.id,
          conversationId: conversation.id,
        });
      const dispatched: Parameters<
        typeof backend.createConversationMessageStream
      >[1][] = [];
      const create = backend.createConversationMessageStream.bind(backend);
      backend.createConversationMessageStream = async (id, body, options) => {
        dispatched.push(structuredClone(body));
        if (queuedKind === "esc" && dispatched.length === 1) {
          const { APIUserAbortError } = await import(
            "@letta-ai/letta-client/core/error"
          );
          return new Promise<Stream<LettaStreamingResponse>>((_, reject) => {
            if (options?.signal?.aborted) reject(new APIUserAbortError());
            else
              options?.signal?.addEventListener(
                "abort",
                () => reject(new APIUserAbortError()),
                { once: true },
              );
          });
        }
        if (
          ["conflict", "transient", "approval-conflict"].includes(queuedKind)
        ) {
          throw Object.assign(
            new Error(
              queuedKind === "approval-conflict"
                ? "approval conflict: pending approval"
                : "request failed",
            ),
            {
              status: queuedKind === "transient" ? 503 : 409,
            },
          );
        }
        return create(id, body, options);
      };
      const mods = join(process.env.LETTA_CONFIG_DIR, "mods");
      mkdirSync(mods, { recursive: true });
      writeFileSync(
        join(mods, "passive.ts"),
        `export default function(letta){letta.events.on("turn_end",event=>{if(event.stopReason==="end_turn")globalThis.__passiveEnded=true;});letta.tools.register({name:"context_tool",description:"Record then queue",approvalPolicy:"auto",parameters:{type:"object",properties:{}},async run(){await globalThis.__passiveRecords.record({id:"during-tool",text:"Context during tool",visibility:"model"});globalThis.__passiveEnqueue();return "real tool output";}});letta.commands.register({id:"record",description:"Record context",async run(ctx){globalThis.__passiveRecords=ctx.conversation.context;await ctx.conversation.context.record({id:"remote",text:"Collaborator data",visibility:"model"});globalThis.__passiveRecorded=true;return {type:"output",output:"Recorded host-local context"};}});}`,
      );
      const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
      stdin.isTTY = true;
      stdin.setRawMode = () => stdin;
      stdin.ref = () => stdin;
      stdin.unref = () => stdin;
      const stdout = new Output();
      failureOutput = () => stdout.frames.join("").slice(-20000);
      app = render(
        <App
          agentId={agent.id}
          agentState={agent}
          conversationId={conversation.id}
          systemInfoReminderEnabled={false}
        />,
        {
          stdin,
          stdout: stdout as Output & NodeJS.WriteStream,
          debug: true,
          patchConsole: false,
          exitOnCtrlC: false,
        },
      );
      await waitFor(isQueueBridgeConnected, "TUI ready");
      await Bun.sleep(150);
      async function send(text: string) {
        stdin.push(text);
        await Bun.sleep(30);
        stdin.push("\r");
      }
      await send("/record");
      await waitFor(() => state.__passiveRecorded === true, "mod recording");
      expect(dispatched).toHaveLength(0);
      expect(await backend.latestConversationRun(conversation.id)).toBeNull();
      const records = state.__passiveRecords;
      if (!records) throw new Error("Missing public records handle");
      expect(await records.list()).toHaveLength(1);
      expect(await records.submissions()).toEqual([]);
      await Bun.sleep(100);
      await send("Explicit human request");
      await waitFor(() => dispatched.length > 0, "native dispatch");
      if (queuedKind === "esc") {
        addToMessageQueue({
          kind: "user",
          text: "Keep queued human after Esc",
          agentId: agent.id,
          conversationId: conversation.id,
        });
        await Bun.sleep(30);
        stdin.push("\u001b");
        await waitFor(
          () => stdout.frames.join("").includes("Interrupted"),
          "Esc acknowledged",
        );
        await Bun.sleep(100);
        stdin.push("\r"); // Existing queue contract: Esc parks human items until Enter.
        await waitFor(
          () => dispatched.length >= 2,
          "queued human survives passive dispatch Esc",
        );
        expect(JSON.stringify(dispatched[1])).toContain(
          "Keep queued human after Esc",
        );
        expect((await records.submissions())[0]?.outcome).toBe("uncertain");
        expect(await records.submissions()).toHaveLength(1);
        await waitFor(
          () => state.__passiveEnded === true,
          "queued human turn completed",
        );
        return;
      }
      if (["conflict", "transient", "approval-conflict"].includes(queuedKind)) {
        await waitFor(
          () => stdout.frames.join("").includes("Automatic retry is fenced"),
          "explicit uncertainty UI",
        );
        await Bun.sleep(200);
        expect(dispatched).toHaveLength(1);
        expect(executions).toBe(0);
        expect((await records.submissions())[0]?.outcome).toBe("uncertain");
        return;
      }
      const messages = dispatched[0]?.messages ?? [];
      expect(
        messages.some(
          (row) =>
            "content" in row &&
            String(row.content).includes("Passive collaborator context"),
        ),
      ).toBe(true);
      expect(
        messages.some(
          (row) =>
            "content" in row &&
            JSON.stringify(row.content).includes("Explicit human request"),
        ),
      ).toBe(true);
      await waitFor(() => dispatched.length >= 2, "queued dispatch after tool");
      const submissions = await records.submissions();
      expect(submissions).toHaveLength(queuedKind === "user" ? 2 : 1);
      const queuedMessages = dispatched[1]?.messages ?? [];
      expect(
        queuedMessages.some(
          (row) =>
            "content" in row &&
            String(row.content).includes("Passive collaborator context"),
        ),
      ).toBe(queuedKind === "user");
      expect((await records.list()).map((record) => record.id)).toEqual([
        "remote",
        "during-tool",
      ]);
      expect(submissions[0]?.outcome).toBe("uncertain");
      const id = submissions[0]?.id;
      if (!id) throw new Error("Missing human identity");
      expect((await records.reconcile(id))?.outcome).toBe("accepted");
    } finally {
      app?.unmount();
      app?.cleanup();
      setMessageQueueAdder(null);
      clearPendingMessages();
      __testSetBackend(null);
      await settingsManager.reset();
      setConfiguredBackendMode(mode);
      restoreAmbientLettaTestEnv(ambient);
      if (openaiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = openaiKey;
      failureOutput = undefined;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete state.__passiveRecords;
      delete state.__passiveRecorded;
      delete state.__passiveEnded;
      delete state.__passiveEnqueue;
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
