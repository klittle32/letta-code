import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { getBackend, __testSetBackend as setBackend } from "@/backend/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { prepareTuiQueuedTurn } from "@/cli/app/turn-input";
import { createBuffers } from "@/cli/helpers/accumulator";
import { sendTuiMessageStream } from "@/cli/helpers/tui-context-stream";
import { runModCommandWithTimeout } from "@/cli/mods/command-runtime";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { DEFAULT_MOD_CAPABILITIES } from "./capabilities";
import { buildModInvocationContext } from "./context";
import type { ModContextRecords } from "./context-records-api";
import { createModConversationHandle } from "./conversation-handle";
import { createModEngine } from "./mod-engine";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
test("actual mod command receives capability-guarded scoped records and disposal revokes writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mod-records-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = process.env.LETTA_CONFIG_DIR;
  process.env.LETTA_CONFIG_DIR = join(root, "config");
  cleanup.push(() => {
    if (config === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = config;
  });
  const previous = getBackend();
  cleanup.push(() => setBackend(previous));
  const state = join(root, "state");
  mkdirSync(state);
  const backend = new LocalBackend({
    storageDir: join(root, "provider"),
    stateStorageDir: state,
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  setBackend(backend);
  const agent = await backend.createAgent({ name: "Mod context" });
  const conversation = await backend.createConversation({ agent_id: agent.id });
  const mods = join(root, "mods");
  mkdirSync(mods);
  writeFileSync(
    join(mods, "records.ts"),
    `export default function(letta){letta.commands.register({id:"record",description:"record",async run(ctx){globalThis.__recordHandle=ctx.conversation.context;if(!ctx.conversation.context)return {type:"output",output:"unsupported"};await ctx.conversation.context.record({id:"remote",text:"shared data",visibility:"model"});return {type:"output",output:"recorded"};}});}`,
  );
  const context = {
    ...buildModInvocationContext({
      agent: { id: agent.id },
      conversationId: conversation.id,
    }),
    command: "record",
    rawInput: "/record",
    args: "",
    argv: [],
    conversation: {
      ...createModConversationHandle({
        backend,
        agentId: agent.id,
        conversationId: conversation.id,
        sendMessageStream: async () => {
          throw new Error("no inference");
        },
      }),
      id: conversation.id,
    },
  };
  const globalHandle = globalThis as typeof globalThis & {
    __recordHandle?: ModContextRecords;
  };
  cleanup.push(() => {
    delete globalHandle.__recordHandle;
  });
  for (const enabled of [false, true]) {
    const engine = createModEngine({
      globalModsDirectory: mods,
      cacheDirectory: join(root, "cache"),
      registerCapabilitiesGlobally: false,
      capabilities: {
        ...DEFAULT_MOD_CAPABILITIES,
        context: { record: enabled },
      },
      getClient: async () => {
        throw new Error("no auth");
      },
    });
    cleanup.push(() => engine.dispose());
    await engine.reload();
    const command = engine.getSnapshot().commands.record!;
    expect(await runModCommandWithTimeout(command, context)).toMatchObject({
      type: "output",
      output: enabled ? "recorded" : "unsupported",
    });
    expect(await backend.latestConversationRun(conversation.id)).toBeNull();
    if (enabled) {
      const handle = globalHandle.__recordHandle!;
      expect(await handle.list()).toHaveLength(1);
      expect(await context.conversation.getHistory()).toEqual([]);
      const preparedToolContext =
        await prepareToolExecutionContextForSpecificTools([], {
          runtimeContext: { mcpOriginatorSuperRunId: null },
        });
      const automatedHandle = createModConversationHandle({
        backend,
        agentId: agent.id,
        conversationId: conversation.id,
        sendMessageStream: (source, id, messages, options, requestOptions) =>
          sendMessageStreamWithBackend(
            source,
            id,
            messages,
            {
              ...options,
              preparedToolContext,
              skillSources: [],
              actingUserId: null,
            },
            requestOptions,
          ),
      });
      const synthetic = await automatedHandle.sendMessageStream([
        {
          role: "user",
          content: "Synthetic mod user message",
          otid: "synthetic-mod",
        },
      ]);
      for await (const _ of synthetic) {
        /* automated public mod send */
      }
      expect(await handle.submissions()).toEqual([]);
      for (const item of [
        { kind: "task_notification" as const, text: "automated" },
        { kind: "user" as const, source: "cron" as const, text: "cron" },
        { kind: "user" as const, text: "human" },
      ]) {
        const turn = prepareTuiQueuedTurn([item], [], createBuffers());
        const stream = await sendTuiMessageStream(conversation.id, turn.input, {
          agentId: agent.id,
          preparedToolContext,
          skillSources: [],
          actingUserId: null,
          humanOtid: turn.options.humanOtid,
        });
        for await (const _ of stream) {
          /* real local backend */
        }
        const bindings = await handle.submissions();
        expect(bindings).toHaveLength(
          item.kind === "user" && !item.source ? 1 : 0,
        );
      }
      const bindings = await handle.submissions();
      expect(bindings[0]?.outcome).toBe("uncertain");
      expect((await handle.reconcile(bindings[0]!.id))?.outcome).toBe(
        "accepted",
      );
      engine.dispose();
      await expect(
        handle.record({ id: "later", text: "later", visibility: "model" }),
      ).rejects.toThrow();
    }
  }
});
