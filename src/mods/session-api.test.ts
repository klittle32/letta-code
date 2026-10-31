import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnInterruptController } from "@/agent/turn-interrupt";
import { runModCommandWithTimeout } from "@/cli/mods/command-runtime";
import { DEFAULT_MOD_CAPABILITIES } from "./capabilities";
import { buildModInvocationContext } from "./context";
import { createModConversationHandle } from "./conversation-handle";
import { createModEngine } from "./mod-engine";
import type { ModSessionActivationRequest } from "./session-api";
import { createHostTurnHandle } from "./turn-handle";
import type { ModCommandContext } from "./types";

async function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "mod-session-"));
  const requests: ModSessionActivationRequest[] = [];
  writeFileSync(
    join(root, "session.ts"),
    `export default function(letta){
 letta.commands.register({id:"interrupt",description:"Interrupt",run(ctx){return {type:"output",output:ctx.turn.requestInterrupt().status};}});
 letta.commands.register({id:"activate",description:"Activate",async run(ctx){const result=await ctx.session.activate({conversationId:"saved",workingDirectory:"/dest"});return {type:"output",output:result.status};}});
 letta.commands.register({id:"detached",description:"Detached",run(ctx){setTimeout(()=>ctx.session.activate({conversationId:"saved",workingDirectory:"/dest"}),10);return {type:"handled"};}});
 }`,
  );
  const engine = createModEngine({
    globalModsDirectory: root,
    cacheDirectory: join(root, "cache"),
    registerCapabilitiesGlobally: false,
    capabilities: {
      ...DEFAULT_MOD_CAPABILITIES,
      session: { activate: enabled },
      turn: { interrupt: true },
    },
    getClient: async () => {
      throw new Error("no client");
    },
    onActivate: async (request) => {
      requests.push(request);
      return new Promise((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => resolve({ status: "refused", reason: "cancelled" }),
          { once: true },
        ),
      );
    },
  });
  await engine.reload();
  const conversation = createModConversationHandle({
    agentId: "agent",
    conversationId: "source",
    sendMessageStream: async () => {
      throw new Error("no send");
    },
  });
  const context: ModCommandContext = {
    ...buildModInvocationContext({
      agent: { id: "agent" },
      conversationId: "source",
      workingDirectory: "/source",
    }),
    command: "activate",
    rawInput: "/activate",
    args: "",
    argv: [],
    conversation: { ...conversation, id: "source" },
  };
  return {
    engine,
    requests,
    context,
    cleanup() {
      engine.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("activation captures exact invocation and reload cancels pending approval", async () => {
  const f = await fixture();
  try {
    const command = f.engine.getSnapshot().commands.activate;
    if (!command) throw new Error("missing command");
    const result = runModCommandWithTimeout(command, f.context);
    await Bun.sleep(1);
    expect(f.requests[0]).toMatchObject({
      sourceConversationId: "source",
      agentId: "agent",
      sourceWorkingDirectory: "/source",
      conversationId: "saved",
    });
    f.context.sessionId = "replacement";
    await f.engine.reload();
    expect(f.requests[0]?.signal.aborted).toBe(true);
    expect(await result).toEqual({ type: "output", output: "refused" });
  } finally {
    f.cleanup();
  }
});
test("handled commands preserve detached invocation; timeout cancels pending activation", async () => {
  const f = await fixture();
  try {
    const command = f.engine.getSnapshot().commands.detached;
    const timed = f.engine.getSnapshot().commands.activate;
    if (!command || !timed) throw new Error("missing command");
    await runModCommandWithTimeout(command, f.context);
    await Bun.sleep(20);
    expect(f.requests[0]?.signal.aborted).toBe(false);
    await expect(runModCommandWithTimeout(timed, f.context, 5)).rejects.toThrow(
      "timed out",
    );
    expect(f.requests[1]?.signal.aborted).toBe(true);
  } finally {
    f.cleanup();
  }
});
test("unsupported hosts expose refusal and no activation callback", async () => {
  const f = await fixture(false);
  try {
    const command = f.engine.getSnapshot().commands.activate;
    if (!command) throw new Error("missing");
    expect(await runModCommandWithTimeout(command, f.context)).toEqual({
      type: "output",
      output: "refused",
    });
    expect(f.requests).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test("invocation abort cancels an admitted activation independently of owner reload", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    f.context.signal = abort.signal;
    const command = f.engine.getSnapshot().commands.activate;
    if (!command) throw new Error("missing");
    const result = runModCommandWithTimeout(command, f.context);
    await Bun.sleep(1);
    abort.abort();
    expect(await result).toEqual({ type: "output", output: "refused" });
    expect(f.requests[0]?.signal.aborted).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("session-enabled command preserves the owner-bound turn Proxy", async () => {
  const f = await fixture();
  try {
    const turn = { id: "turn", agentId: "agent", conversationId: "source" };
    let aborted = false;
    f.context.turn = createHostTurnHandle(
      turn,
      createTurnInterruptController({
        turn,
        isCurrent: () => true,
        abort: () => {
          aborted = true;
        },
        settlement: {},
      }),
    );
    const command = f.engine.getSnapshot().commands.interrupt;
    if (!command) throw new Error("missing command");
    expect(await command.run(f.context)).toEqual({
      type: "output",
      output: "requested",
    });
    expect(aborted).toBe(true);
  } finally {
    f.cleanup();
  }
});
