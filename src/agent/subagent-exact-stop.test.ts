import { expect, test } from "bun:test";
import {
  clearSubagentAbortHook,
  clearSubagentsByIds,
  getSubagents,
  interruptSubagentById,
  registerSubagent,
  registerSubagentAbortHook,
  updateSubagent,
} from "./subagent-state";

test("exact stop marks before synchronous hook settlement and does not touch siblings", () => {
  const ids = ["exact-stop", "exact-sibling"];
  try {
    for (const id of ids) registerSubagent(id, "test", "fixture", id, false);
    let pending = false;
    registerSubagentAbortHook(ids[0] as string, () => {
      pending = !!getSubagents().find((row) => row.id === ids[0])
        ?.cancelPending;
      updateSubagent(ids[0] as string, { cancelPending: undefined });
    });
    expect(interruptSubagentById("exact-stop", "lost turn")).toBe("requested");
    expect(pending).toBe(true);
    expect(
      getSubagents().find((row) => row.id === "exact-stop")?.cancelPending,
    ).toBeUndefined();
    expect(
      getSubagents().find((row) => row.id === "exact-sibling")?.status,
    ).toBe("pending");
    expect(interruptSubagentById("exact-sibling", "lost turn")).toBe(
      "unavailable",
    );
  } finally {
    for (const id of ids) clearSubagentAbortHook(id);
    clearSubagentsByIds(ids);
  }
});

test("a throwing exact stop hook records failure without touching siblings", () => {
  const id = "exact-stop-throws";
  registerSubagent(id, "test", "fixture", "tool", false);
  try {
    registerSubagentAbortHook(id, () => {
      throw new Error("stop unavailable");
    });
    expect(interruptSubagentById(id, "lost turn")).toBe("requested");
    expect(getSubagents().find((row) => row.id === id)).toMatchObject({
      status: "running",
      stopFailed: true,
      cancelPending: undefined,
    });
  } finally {
    clearSubagentAbortHook(id);
    clearSubagentsByIds([id]);
  }
});
