import { expect, test } from "bun:test";
import {
  admitTuiApprovalPause,
  recoverTuiApprovalInput,
} from "./tui-approval-recovery";
import { createTuiTurnControl } from "./tui-turn-control";

test("retired companions survive scope replacement and backend ID validation", async () => {
  const owner = {};
  const scope = {
    id: "old",
    agentId: "agent",
    conversationId: "old-conversation",
  };
  const turn = createTuiTurnControl({
    turn: scope,
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  turn.enter();
  admitTuiApprovalPause(
    turn,
    owner,
    [{ toolCallId: "pending", toolName: "Read", toolArgs: "{}" }],
    [
      {
        toolCallId: "companion",
        result: { status: "success", toolReturn: "real companion" },
      },
    ],
  );
  await turn.leave(true);
  const receipt = turn.request(new AbortController().signal);
  if (receipt.status !== "requested") throw new Error("missing receipt");
  await receipt.completion;
  const input = [
    { type: "message" as const, role: "user" as const, content: "recover" },
  ];
  let queries = 0;
  expect(
    await recoverTuiApprovalInput(
      owner,
      { ...scope, conversationId: "replacement" },
      input,
      () => true,
      async () => {
        queries++;
        return ["pending", "companion"];
      },
    ),
  ).toEqual(input);
  expect(queries).toBe(0);
  const recovered = await recoverTuiApprovalInput(
    owner,
    scope,
    input,
    () => true,
    async () => ["pending", "companion"],
  );
  expect(JSON.stringify(recovered)).toContain("real companion");
  expect(
    JSON.stringify(
      await recoverTuiApprovalInput(
        owner,
        scope,
        input,
        () => true,
        async () => ["pending", "companion"],
      ),
    ),
  ).toContain("real companion");
  expect(JSON.stringify(recovered)).toContain(
    "Turn interrupted before approval execution",
  );
  expect(
    await recoverTuiApprovalInput(
      owner,
      scope,
      input,
      () => true,
      async () => [],
    ),
  ).toEqual(input);
});

test("replacement during backend validation retains original recovery for a later send", async () => {
  const owner = {};
  const scope = { id: "old", agentId: "agent", conversationId: "old" };
  const turn = createTuiTurnControl({
    turn: scope,
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  turn.enter();
  admitTuiApprovalPause(turn, owner, [
    { toolCallId: "pending", toolName: "Read", toolArgs: "{}" },
  ]);
  await turn.leave(true);
  turn.request(new AbortController().signal);
  expect(
    await recoverTuiApprovalInput(
      owner,
      scope,
      [],
      () => false,
      async () => ["pending"],
    ),
  ).toEqual([]);
  expect(
    await recoverTuiApprovalInput(
      owner,
      scope,
      [],
      () => true,
      async () => ["pending"],
    ),
  ).toHaveLength(1);
});

test("real saved companions replace eager recovery denials for matching IDs", async () => {
  const owner = {};
  const scope = { id: "old", agentId: "agent", conversationId: "old" };
  const turn = createTuiTurnControl({
    turn: scope,
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  turn.enter();
  admitTuiApprovalPause(
    turn,
    owner,
    [],
    [
      {
        toolCallId: "companion",
        result: { status: "success", toolReturn: "real output" },
      },
    ],
  );
  await turn.leave(true);
  turn.request(new AbortController().signal);
  const recovered = await recoverTuiApprovalInput(
    owner,
    scope,
    [
      {
        type: "approval",
        approvals: [
          {
            type: "approval",
            tool_call_id: "companion",
            approve: false,
            reason: "stale",
          },
        ],
      },
    ],
    () => true,
    async () => ["companion"],
  );
  expect(JSON.stringify(recovered)).toContain("real output");
  expect(JSON.stringify(recovered)).not.toContain('"reason":"stale"');
});

test("a failed resume lookup does not erase unsent scoped recovery", async () => {
  const owner = {};
  const scope = { id: "old", agentId: "agent", conversationId: "old" };
  const turn = createTuiTurnControl({
    turn: scope,
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  turn.enter();
  admitTuiApprovalPause(turn, owner, [
    { toolCallId: "pending", toolName: "Read", toolArgs: "{}" },
  ]);
  await turn.leave(true);
  turn.request(new AbortController().signal);
  await expect(
    recoverTuiApprovalInput(
      owner,
      scope,
      [],
      () => true,
      async () => {
        throw new Error("lookup failed");
      },
    ),
  ).rejects.toThrow("lookup failed");
  expect(
    await recoverTuiApprovalInput(
      owner,
      scope,
      [],
      () => true,
      async () => ["pending"],
    ),
  ).toHaveLength(1);
});

test("an inconclusive empty history neither discards recovery nor blocks unrelated input", async () => {
  const owner = {};
  const scope = { id: "old", agentId: "agent", conversationId: "old" };
  const turn = createTuiTurnControl({
    turn: scope,
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  turn.enter();
  admitTuiApprovalPause(turn, owner, [
    { toolCallId: "pending", toolName: "Read", toolArgs: "{}" },
  ]);
  await turn.leave(true);
  turn.request(new AbortController().signal);
  expect(
    await recoverTuiApprovalInput(
      owner,
      scope,
      [],
      () => true,
      async () => undefined,
    ),
  ).toEqual([]);
  expect(
    await recoverTuiApprovalInput(
      owner,
      scope,
      [],
      () => true,
      async () => ["pending"],
    ),
  ).toHaveLength(1);
});

test("null and absent approval arrays remain unchanged during recovery", async () => {
  const owner = {};
  const scope = { id: "old", agentId: "agent", conversationId: "old" };
  const turn = createTuiTurnControl({
    turn: scope,
    isCurrent: () => true,
    cancelRun: async () => {},
  });
  turn.enter();
  admitTuiApprovalPause(turn, owner, [
    { toolCallId: "pending", toolName: "Read", toolArgs: "{}" },
  ]);
  await turn.leave(true);
  turn.request(new AbortController().signal);
  const input = [
    { type: "approval" as const, approvals: null },
    { type: "approval" as const },
  ];
  const recovered = await recoverTuiApprovalInput(
    owner,
    scope,
    input,
    () => true,
    async () => ["pending"],
  );
  expect(recovered.slice(1)).toEqual(input);
});
