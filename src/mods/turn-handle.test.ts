import { expect, test } from "bun:test";
import { createTurnInterruptController } from "@/agent/turn-interrupt";
import { bindModTurnHandle, createHostTurnHandle } from "./turn-handle";

test("captured handle is bound to the activation generation and exact turn", () => {
  let aborts = 0;
  let current = true;
  const host = createHostTurnHandle(
    { id: "first", agentId: "agent", conversationId: "conversation" },
    createTurnInterruptController({
      turn: { id: "first", agentId: "agent", conversationId: "conversation" },
      isCurrent: () => current,
      abort: () => {
        aborts++;
      },
      settlement: {},
    }),
  );
  const owner = new AbortController();
  const captured = bindModTurnHandle(host, owner.signal);
  owner.abort();
  expect(captured?.requestInterrupt()).toEqual({
    status: "not-applied",
    reason: "inactive-owner",
  });
  current = false;
  expect(
    bindModTurnHandle(host, new AbortController().signal)?.requestInterrupt(),
  ).toEqual({ status: "not-applied", reason: "stale-turn" });
  expect(aborts).toBe(0);
});
