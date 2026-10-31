import { expect, test } from "bun:test";
import { createTuiTurnControl } from "./tui-turn-control";

function control() {
  return createTuiTurnControl({
    turn: { id: "original", agentId: "agent", conversationId: "conversation" },
    isCurrent: () => true,
    cancelRun: async () => {},
  });
}

test.each(["before-pause", "before-subscription", "after-subscription"])(
  "paused abort retires once: %s",
  async (order) => {
    const turn = control();
    const events: string[] = [];
    let retired = 0;
    turn.setTerminalHandler(async (reason) => {
      events.push(reason);
      return "ignored continuation";
    });
    turn.enter();
    turn.expectApprovalPause(["pending"], () => {
      retired++;
    });
    let receipt: ReturnType<typeof turn.request> | undefined;
    if (order === "before-pause")
      receipt = turn.request(new AbortController().signal);
    await turn.leave(true);
    if (order === "before-subscription")
      receipt = turn.request(new AbortController().signal);
    const dispose = turn.onPausedAbort(() => {
      turn.retireApprovalPause(() => {});
    });
    if (order === "after-subscription")
      receipt = turn.request(new AbortController().signal);
    if (receipt?.status !== "requested") throw new Error("missing receipt");
    expect((await receipt.wait(100)).status).toBe("settled");
    expect(retired).toBe(1);
    expect(events).toEqual(["cancelled"]);
    expect(await turn.end("error")).toBeUndefined();
    dispose();
  },
);

test("running approval cannot be retired as untouched; terminal does not await tools", async () => {
  const turn = control();
  let retired = 0;
  const events: string[] = [];
  turn.setTerminalHandler(async (reason) => {
    events.push(reason);
    return undefined;
  });
  turn.enter();
  await turn.leave(true);
  turn.onPausedAbort(() =>
    turn.retireApprovalPause(() => {
      retired++;
    }),
  );
  turn.enter();
  const ticket = turn.executionSettlement.register("running");
  ticket.start();
  const receipt = turn.request(new AbortController().signal);
  await turn.leave(false);
  expect(retired).toBe(0);
  expect(events).toEqual(["cancelled"]);
  if (receipt.status !== "requested") throw new Error("missing receipt");
  expect(await receipt.wait(1)).toMatchObject({
    status: "incomplete",
    pending: expect.arrayContaining(["tools"]),
  });
  ticket.finish();
  await receipt.completion;
});

test("nested continuations emit one terminal with error fallback and no self-await", async () => {
  const turn = control();
  const events: string[] = [];
  turn.setTerminalHandler(async (reason) => {
    events.push(reason);
    turn.request(new AbortController().signal);
    return "must not continue";
  });
  turn.enter();
  turn.enter();
  expect(await turn.end("end_turn")).toBeUndefined();
  await turn.leave(false);
  await turn.leave(false);
  expect(events).toEqual(["end_turn"]);
  const failed = control();
  failed.setTerminalHandler(async (reason) => {
    events.push(reason);
    return undefined;
  });
  failed.enter();
  await failed.leave(false);
  expect(events).toEqual(["end_turn", "error"]);
});
