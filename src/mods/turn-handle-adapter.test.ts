import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnInterruptController } from "@/agent/turn-interrupt";
import { DEFAULT_MOD_CAPABILITIES } from "./capabilities";
import { buildModInvocationContext } from "./context";
import { createModAdapter } from "./mod-adapter";
import { createHostTurnHandle } from "./turn-handle";
import type { ModTurnHandle } from "./types";

test("real adapter binds event handles to the reloaded owner generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "turn-owner-"));
  const captured: ModTurnHandle[] = [];
  const scope = globalThis as typeof globalThis & {
    __turnOwnerCapture?: (turn: ModTurnHandle) => void;
  };
  scope.__turnOwnerCapture = (turn) => captured.push(turn);
  writeFileSync(
    join(root, "capture.ts"),
    `export default function(letta) {
    letta.events.on("turn_start", (_event,ctx) => globalThis.__turnOwnerCapture(ctx.turn));
  }`,
  );
  const adapter = createModAdapter({
    globalModsDirectory: root,
    cacheDirectory: join(root, "cache"),
    capabilities: { ...DEFAULT_MOD_CAPABILITIES, turn: { interrupt: true } },
    getClient: async () => {
      throw new Error("Turn-handle binding must not access the API client");
    },
  });
  let aborted = 0;
  const turn = {
    id: "host-turn",
    agentId: "agent",
    conversationId: "conversation",
  };
  const context = buildModInvocationContext({
    agent: { id: "agent" },
    conversationId: "conversation",
  });
  context.turn = createHostTurnHandle(
    turn,
    createTurnInterruptController({
      turn,
      isCurrent: () => true,
      abort: () => {
        aborted++;
      },
      settlement: {},
    }),
  );
  try {
    await adapter.reload();
    await adapter.events.emit(
      "turn_start",
      { agentId: "agent", conversationId: "conversation", input: [] },
      context,
    );
    expect(captured).toHaveLength(1);
    await adapter.reload();
    expect(captured[0]?.requestInterrupt()).toEqual({
      status: "not-applied",
      reason: "inactive-owner",
    });
    await adapter.events.emit(
      "turn_start",
      { agentId: "agent", conversationId: "conversation", input: [] },
      context,
    );
    expect(captured[1]?.requestInterrupt().status).toBe("requested");
    expect(aborted).toBe(1);
    expect(
      buildModInvocationContext({ base: context, conversationId: "elsewhere" })
        .turn,
    ).toBeUndefined();
    expect(buildModInvocationContext({ base: context }).turn?.id).toBe(turn.id);
  } finally {
    adapter.dispose();
    delete scope.__turnOwnerCapture;
    rmSync(root, { recursive: true, force: true });
  }
});
