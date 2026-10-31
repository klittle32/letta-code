import { expect, test } from "bun:test";
import { buildRetiredApprovalResults } from "./tui-approval-recovery";
import { bindApprovalRetirement } from "./tui-approval-retirement";
import { createTuiTurnControl } from "./tui-turn-control";

test("untouched approvals become denials while real companions and precomputed results survive", () => {
  const a = { toolCallId: "a", toolName: "Read", toolArgs: "{}" };
  const b = { ...a, toolCallId: "b" };
  const results = buildRetiredApprovalResults(
    [a, b],
    [
      {
        type: "approve",
        approval: b,
        precomputedResult: { status: "success", toolReturn: "already done" },
      },
    ],
    [
      {
        toolCallId: "companion",
        result: { status: "success", toolReturn: "companion done" },
      },
    ],
    [],
  );
  expect(results).toEqual(
    expect.arrayContaining([
      {
        type: "approval",
        tool_call_id: "a",
        approve: false,
        reason: "Turn interrupted before approval execution",
      },
      expect.objectContaining({
        tool_call_id: "b",
        tool_return: "already done",
      }),
      expect.objectContaining({
        tool_call_id: "companion",
        tool_return: "companion done",
      }),
    ]),
  );
});

test("accepted paused interruption finalizes before a stale retirement subscription", async () => {
  const turn = createTuiTurnControl({
    turn: { id: "old", agentId: "agent", conversationId: "conv" },
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  const ended: string[] = [];
  let ui = 0;
  let saved = 0;
  turn.setTerminalHandler(async (reason) => {
    ended.push(reason);
    return undefined;
  });
  turn.enter();
  turn.expectApprovalPause(["pending"], () => {
    saved++;
  });
  await turn.leave(true);
  const receipt = turn.request(new AbortController().signal);
  const dispose = bindApprovalRetirement(
    turn,
    () => false,
    () => {
      ui++;
    },
  );
  if (receipt.status !== "requested") throw new Error("missing receipt");
  expect((await receipt.wait(100)).status).toBe("settled");
  expect(turn.active).toBe(false);
  expect(ended).toEqual(["cancelled"]);
  expect(saved).toBe(1);
  expect(ui).toBe(0);
  dispose();
});

test("pause admission owns retirement even when no UI effect ever subscribes", async () => {
  const turn = createTuiTurnControl({
    turn: { id: "old", agentId: "agent", conversationId: "conv" },
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  let saved = 0;
  turn.enter();
  turn.expectApprovalPause(["pending"], () => {
    saved++;
  });
  const receipt = turn.request(new AbortController().signal);
  await turn.leave(true);
  if (receipt.status !== "requested") throw new Error("missing receipt");
  expect((await receipt.wait(100)).status).toBe("settled");
  expect(saved).toBe(1);
  expect(turn.active).toBe(false);
});
