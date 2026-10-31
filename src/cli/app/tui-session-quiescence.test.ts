import { expect, test } from "bun:test";
import { enterTuiLogicalTurn, hasUnsettledTuiTurns } from "./tui-turn-owner";

test("an older signal-ignoring tool blocks activation after a replacement turn finished", async () => {
  const ref = { current: null as AbortController | null };
  const generationRef = { current: 0 };
  const options = {
    ref,
    generationRef,
    generation: 0,
    continuation: false,
    agentId: "agent",
    conversationId: "source",
  };
  const old = enterTuiLogicalTurn(options);
  const ticket = old.executionSettlement.register("ignoring");
  ticket.start();
  old.request(new AbortController().signal);
  await old.leave(false);
  const next = enterTuiLogicalTurn(options);
  await next.leave(false);
  expect(hasUnsettledTuiTurns(ref, "agent", "source")).toBe(true);
  expect(hasUnsettledTuiTurns(ref, "agent", "other")).toBe(false);
  ticket.finish();
  await Bun.sleep(1);
  expect(hasUnsettledTuiTurns(ref, "agent", "source")).toBe(false);
});
