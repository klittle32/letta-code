import { afterEach, expect, test } from "bun:test";
import { ApprovalExecutionSettlement } from "@/agent/approval-execution-settlement";
import {
  clearSubagentAbortHook,
  clearSubagentsByIds,
  getSubagents,
  registerSubagent,
  registerSubagentAbortHook,
  updateSubagent,
} from "@/agent/subagent-state";
import { createTuiChildSettlement } from "./tui-child-settlement";

const ids: string[] = [];
afterEach(() => {
  for (const id of ids) {
    updateSubagent(id, { cancelPending: undefined });
    clearSubagentAbortHook(id);
  }
  clearSubagentsByIds(ids.splice(0));
});
function child(
  id: string,
  toolCallId: string | undefined,
  background = false,
  conversationId: string | null = "conversation",
) {
  ids.push(id);
  registerSubagent(id, "test", "child", toolCallId, background, false, {
    agentId: "agent",
    conversationId: conversationId ?? undefined,
  });
}
function setup() {
  const tools = new ApprovalExecutionSettlement();
  const ticket = tools.register("owned-tool");
  ticket.start();
  const children = createTuiChildSettlement(
    { id: "turn", agentId: "agent", conversationId: "conversation" },
    tools,
  );
  return { tools, ticket, children };
}
function stopped(id: string) {
  updateSubagent(id, {
    status: "error",
    cancelPending: undefined,
    stopFailed: undefined,
  });
}

test("only exact foreground children are stopped; background, other turns and conversations survive", async () => {
  const { tools, ticket, children } = setup();
  const stoppedIds: string[] = [];
  for (const [id, tool, bg, conv] of [
    ["owned", "owned-tool", false, "conversation"],
    ["background", "owned-tool", true, "conversation"],
    ["old-turn", "old-tool", false, "conversation"],
    ["elsewhere", "owned-tool", false, "elsewhere"],
  ] as const) {
    child(id, tool, bg, conv);
    registerSubagentAbortHook(id, () => {
      stoppedIds.push(id);
      stopped(id);
    });
  }
  tools.cancel();
  children.cancel();
  ticket.finish();
  await children.wait();
  expect(stoppedIds).toEqual(["owned"]);
  expect(
    getSubagents()
      .filter((row) => row.id !== "owned")
      .every((row) => row.status === "pending"),
  ).toBe(true);
});

test("late foreground registration stays watched while its ticket is running and cancelPending keeps settlement open", async () => {
  const { tools, ticket, children } = setup();
  tools.cancel();
  children.cancel();
  child("late", "owned-tool");
  let calls = 0;
  registerSubagentAbortHook("late", () => {
    calls++;
  });
  expect(calls).toBe(1);
  ticket.finish();
  let settled = false;
  const waiting = children.wait().then(() => {
    settled = true;
  });
  await Bun.sleep(1);
  expect(settled).toBe(false);
  stopped("late");
  await waiting;
  expect(settled).toBe(true);
});

test.each(["no-hook", "missing-ticket", "missing-scope", "stop-failed"])(
  "%s remains incomplete without widening",
  async (kind) => {
    const { tools, ticket, children } = setup();
    let calls = 0;
    child(
      kind,
      kind === "missing-ticket" ? undefined : "owned-tool",
      false,
      kind === "missing-scope" ? null : "conversation",
    );
    if (kind !== "no-hook")
      registerSubagentAbortHook(kind, () => {
        calls++;
        updateSubagent(kind, {
          cancelPending: undefined,
          status: "running",
          stopFailed: true,
        });
      });
    tools.cancel();
    children.cancel();
    ticket.finish();
    await expect(children.wait()).rejects.toThrow();
    expect(calls).toBe(kind === "stop-failed" ? 1 : 0);
  },
);

test("a foreground child can finish naturally before its ticket settles without a stop hook", async () => {
  const { tools, ticket, children } = setup();
  child("natural", "owned-tool");
  tools.cancel();
  children.cancel();
  stopped("natural");
  ticket.finish();
  await children.wait();
});

test("a child with the same tool ID in another agent stays untouched", async () => {
  const { tools, ticket, children } = setup();
  ids.push("other-agent");
  registerSubagent("other-agent", "test", "child", "owned-tool", false, false, {
    agentId: "other",
    conversationId: "conversation",
  });
  tools.cancel();
  children.cancel();
  ticket.finish();
  await children.wait();
  expect(getSubagents().find((row) => row.id === "other-agent")?.status).toBe(
    "pending",
  );
});
