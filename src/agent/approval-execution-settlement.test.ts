import { expect, test } from "bun:test";
import {
  executeApprovalBatch,
  executeAutoAllowedTools,
} from "@/agent/approval-execution";
import { ApprovalExecutionSettlement } from "@/agent/approval-execution-settlement";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function approval(toolCallId: string, toolName = "Read") {
  return {
    toolCallId,
    toolName,
    toolArgs: JSON.stringify({ file_path: "/tmp/settlement-test" }),
  };
}

test("actual execution and checkpoint outlive responsive abort settlement", async () => {
  const owner = new ApprovalExecutionSettlement();
  const controller = new AbortController();
  const started = deferred();
  const tool = deferred();
  const checkpoint = deferred();
  const batch = executeApprovalBatch(
    [{ type: "approve", approval: approval("a") }],
    undefined,
    {
      executionSettlement: owner,
      abortSignal: controller.signal,
      executeTool: async () => {
        started.resolve();
        await tool.promise;
        return { status: "success", toolReturn: "ok" };
      },
      afterToolExecution: async () => checkpoint.promise,
    },
  ).catch((error: Error) => error);
  await started.promise;
  controller.abort();
  expect(await batch).toBeInstanceOf(Error);
  expect(owner.snapshot()).toEqual([
    { toolCallId: "a", state: "running", executed: true },
  ]);
  let settled = false;
  const waiting = owner.waitForSettlement().then(() => {
    settled = true;
  });
  tool.resolve();
  await Bun.sleep(1);
  expect(settled).toBe(false);
  checkpoint.resolve();
  await waiting;
  expect(owner.pendingToolCallIds()).toEqual([]);
});

test("cancel fences queued writes and post-durability-fence starts", async () => {
  const owner = new ApprovalExecutionSettlement();
  const entered = deferred();
  const fence = deferred();
  const calls: string[] = [];
  const chunks: Array<{ tool_call_id: string; status: string }> = [];
  const controller = new AbortController();
  const batch = executeApprovalBatch(
    ["a", "b"].map((id) => ({
      type: "approve",
      approval: approval(id, "Write"),
    })),
    (chunk) => {
      chunks.push(chunk);
    },
    {
      executionSettlement: owner,
      abortSignal: controller.signal,
      beforeToolExecution: async () => {
        entered.resolve();
        await fence.promise;
      },
      executeTool: async (name) => {
        calls.push(name);
        return { status: "success", toolReturn: "ok" };
      },
    },
  );
  await entered.promise;
  owner.cancel();
  controller.abort();
  fence.resolve();
  await batch;
  await owner.waitForSettlement();
  expect(calls).toEqual([]);
  expect(
    chunks.map(({ tool_call_id, status }) => ({ tool_call_id, status })),
  ).toEqual([
    { tool_call_id: "a", status: "error" },
    { tool_call_id: "b", status: "error" },
  ]);
  expect(owner.snapshot().every((item) => !item.executed)).toBe(true);
});

test("denied and precomputed calls are not executions; independent owners stay live", async () => {
  const owner = new ApprovalExecutionSettlement();
  await executeApprovalBatch(
    [
      { type: "deny", approval: approval("denied"), reason: "no" },
      {
        type: "approve",
        approval: approval("computed"),
        precomputedResult: { status: "success", toolReturn: "done" },
      },
    ],
    undefined,
    { executionSettlement: owner },
  );
  expect(owner.snapshot().every((item) => !item.executed)).toBe(true);
  owner.cancel();
  const other = new ApprovalExecutionSettlement();
  let calls = 0;
  await executeAutoAllowedTools([{ approval: approval("auto") }], () => {}, {
    executionSettlement: other,
    executeTool: async () => {
      calls++;
      return { status: "success", toolReturn: "ok" };
    },
  });
  expect(calls).toBe(1);
  expect(other.snapshot()[0]?.executed).toBe(true);
});

test("aborted serialized siblings never start after a straggler settles", async () => {
  const owner = new ApprovalExecutionSettlement();
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const batch = executeApprovalBatch(
    ["first", "queued"].map((id) => ({
      type: "approve",
      approval: approval(id, "Write"),
    })),
    undefined,
    {
      executionSettlement: owner,
      abortSignal: controller.signal,
      executeTool: async () => {
        calls++;
        entered.resolve();
        await release.promise;
        throw new Error("late tool rejection");
      },
    },
  ).catch(() => {});
  await entered.promise;
  controller.abort();
  await batch;
  expect(owner.pendingToolCallIds()).toEqual(["first", "queued"]);
  release.resolve();
  await owner.waitForSettlement();
  expect(calls).toBe(1);
  expect(owner.snapshot().map((item) => item.executed)).toEqual([true, false]);
});

test("pre-cancelled owner fences new batches and failed fences release queued tickets", async () => {
  const owner = new ApprovalExecutionSettlement();
  owner.cancel();
  let calls = 0;
  await executeAutoAllowedTools([{ approval: approval("late") }], () => {}, {
    executionSettlement: owner,
    executeTool: async () => {
      calls++;
      return { status: "success", toolReturn: "ok" };
    },
  });
  expect(calls).toBe(0);
  await owner.waitForSettlement();
  const failing = new ApprovalExecutionSettlement();
  await expect(
    executeApprovalBatch(
      ["first", "queued"].map((id) => ({
        type: "approve",
        approval: approval(id, "Write"),
      })),
      undefined,
      {
        executionSettlement: failing,
        beforeToolExecution: () => {
          throw new Error("durability failure");
        },
      },
    ),
  ).rejects.toThrow("durability failure");
  await failing.waitForSettlement();
  expect(failing.pendingToolCallIds()).toEqual([]);
  expect(failing.snapshot().every((item) => !item.executed)).toBe(true);
});

test("late checkpoint rejection is safely retained after abort grace", async () => {
  const owner = new ApprovalExecutionSettlement();
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const batch = executeApprovalBatch(
    [{ type: "approve", approval: approval("failure") }],
    undefined,
    {
      executionSettlement: owner,
      abortSignal: controller.signal,
      executeTool: async () => {
        entered.resolve();
        await release.promise;
        return { status: "success", toolReturn: "ok" };
      },
      afterToolExecution: () => {
        throw new Error("checkpoint failed");
      },
    },
  ).catch(() => {});
  await entered.promise;
  controller.abort();
  await batch;
  release.resolve();
  await owner.waitForSettlement();
  expect(owner.snapshot()[0]?.error).toBeInstanceOf(Error);
});
