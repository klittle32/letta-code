import { afterEach, expect, test } from "bun:test";
import {
  clearSubagentsByIds,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import { getTuiSessionActivationBlocker } from "./tui-session-admission";

const ids: string[] = [];
afterEach(() => {
  for (const id of ids) updateSubagent(id, { cancelPending: undefined });
  clearSubagentsByIds(ids.splice(0));
});
const request = {
  agentId: "agent",
  sourceConversationId: "source",
  sourceWorkingDirectory: "/source",
  conversationId: "target",
  workingDirectory: "/target",
  owner: { id: "mod", generation: 1, path: "mod.ts", scope: "global" as const },
  signal: new AbortController().signal,
};
function activity() {
  return {
    commandBlocked: false,
    processing: 0,
    executing: false,
    approvals: 0,
    results: 0,
    queued: 0,
    turnRef: { current: null },
  };
}
test.each(["processing", "approvals", "results", "queued"] as const)(
  "%s blocks activation",
  (key) => {
    const value = activity();
    value[key] = 1;
    expect(getTuiSessionActivationBlocker(request, value)).toBeDefined();
  },
);
test("running tools and other commands block activation", () => {
  expect(
    getTuiSessionActivationBlocker(request, { ...activity(), executing: true }),
  ).toBeDefined();
  expect(
    getTuiSessionActivationBlocker(request, {
      ...activity(),
      commandBlocked: true,
    }),
  ).toBeDefined();
});
test.each([false, true])(
  "all scoped children block activation, background=%s",
  (background) => {
    const id = `scoped-${background}`;
    ids.push(id);
    registerSubagent(id, "test", "child", "tool", background, false, {
      agentId: "agent",
      conversationId: "source",
    });
    expect(getTuiSessionActivationBlocker(request, activity())).toBeDefined();
    updateSubagent(id, { status: "error", cancelPending: true });
    expect(getTuiSessionActivationBlocker(request, activity())).toBeDefined();
    updateSubagent(id, { cancelPending: undefined, stopFailed: true });
    expect(getTuiSessionActivationBlocker(request, activity())).toBeDefined();
    updateSubagent(id, { stopFailed: undefined });
    expect(getTuiSessionActivationBlocker(request, activity())).toBeUndefined();
  },
);
test("unrelated child scopes do not block; unknown ownership remains conservative", () => {
  for (const [id, agentId, conversationId] of [
    ["other-conv", "agent", "other"],
    ["other-agent", "other", "source"],
  ]) {
    if (!id) throw new Error("fixture");
    ids.push(id);
    registerSubagent(id, "test", "child", "tool", true, false, {
      agentId,
      conversationId,
    });
  }
  expect(getTuiSessionActivationBlocker(request, activity())).toBeUndefined();
  ids.push("unknown");
  registerSubagent("unknown", "test", "child", "tool", true);
  expect(getTuiSessionActivationBlocker(request, activity())).toBeDefined();
});
test("pending host overlays block activation", () => {
  expect(
    getTuiSessionActivationBlocker(request, { ...activity(), blockedUi: true }),
  ).toBeDefined();
});
