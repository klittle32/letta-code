import { expect, test } from "bun:test";
import { createTuiTurnControl } from "./tui-turn-control";

function setup() {
  let current = true;
  const cancellations: string[] = [];
  const control = createTuiTurnControl({
    turn: { id: "one", agentId: "agent", conversationId: "conversation" },
    isCurrent: () => current,
    cancelRun: async (id) => {
      cancellations.push(id);
    },
  });
  return {
    control,
    cancellations,
    stale: () => {
      current = false;
    },
  };
}

test("pre-stream request fences execution synchronously without awaiting the hook", async () => {
  const { control } = setup();
  control.enter();
  const receipt = control.request(new AbortController().signal);
  expect(receipt.status).toBe("requested");
  expect(control.signal.aborted).toBe(true);
  expect(control.executionSettlement.cancelled).toBe(true);
  control.leave(false);
  if (receipt.status === "requested")
    expect((await receipt.completion).status).toBe("settled");
});

test("approval pause retains identity; stale and disposed owners cannot cancel", () => {
  const { control, stale } = setup();
  control.enter();
  control.leave(true);
  expect(control.active).toBe(true);
  const owner = new AbortController();
  owner.abort();
  expect(control.request(owner.signal)).toEqual({
    status: "not-applied",
    reason: "inactive-owner",
  });
  stale();
  expect(control.request(new AbortController().signal)).toEqual({
    status: "not-applied",
    reason: "stale-turn",
  });
});

test("unknown backend ownership is incomplete, never broad cancellation", async () => {
  const { control, cancellations } = setup();
  control.enter();
  control.beginBackend();
  const receipt = control.request(new AbortController().signal);
  control.leave(false);
  if (receipt.status !== "requested") throw new Error("missing receipt");
  expect(await receipt.completion).toMatchObject({
    status: "incomplete",
    errors: [{ resource: "backend" }],
  });
  expect(cancellations).toEqual([]);
});

test("ignoring tools remain pending beyond owner completion and checkpoint errors are reported", async () => {
  const { control } = setup();
  control.enter();
  const ticket = control.executionSettlement.register("tool");
  ticket.start();
  const receipt = control.request(new AbortController().signal);
  control.leave(false);
  if (receipt.status !== "requested") throw new Error("missing receipt");
  expect(await receipt.wait(1)).toMatchObject({
    status: "incomplete",
    pending: ["tools", "children"],
  });
  ticket.finish(new Error("checkpoint failed"));
  expect(await receipt.completion).toMatchObject({
    status: "incomplete",
    errors: [{ resource: "tools", message: "checkpoint failed" }],
  });
});

test("exact backend cancellation failure never retargets and child ownership gaps remain visible", async () => {
  const ids: string[] = [];
  const control = createTuiTurnControl({
    turn: { id: "exact", agentId: "agent", conversationId: "conversation" },
    isCurrent: () => true,
    cancelRun: async (id) => {
      ids.push(id);
      throw new Error("cancel failed");
    },
    children: () => ({
      cancel() {},
      async wait() {
        throw new Error("ownership gap");
      },
    }),
  });
  control.enter();
  control.beginBackend();
  control.observeRun("observed-run");
  const receipt = control.request(new AbortController().signal);
  control.observeRun("later-run");
  control.leave(false);
  if (receipt.status !== "requested") throw new Error("missing receipt");
  expect(ids).toEqual(["observed-run"]);
  expect(await receipt.completion).toMatchObject({
    status: "incomplete",
    errors: [
      { resource: "backend", message: "cancel failed" },
      { resource: "children" },
    ],
  });
});

test.each(["inactive-owner", "stale-turn", "cached"])(
  "%s reentry cannot mutate accepted resource snapshots",
  async (kind) => {
    let current = true;
    let children = true;
    const cancelled: string[] = [];
    const owner = new AbortController();
    const rejectedOwner = new AbortController();
    rejectedOwner.abort();
    const control = createTuiTurnControl({
      turn: { id: "one", agentId: "agent", conversationId: "conversation" },
      isCurrent: () => current,
      children: () => {
        let captured = false;
        return {
          cancel() {
            captured = children;
          },
          async wait() {
            if (captured) throw new Error("ownership gap");
          },
        };
      },
      cancelRun: async (id) => {
        cancelled.push(id);
      },
    });
    control.enter();
    control.beginBackend();
    control.observeRun("original");
    control.signal.addEventListener("abort", () => {
      control.observeRun("replacement");
      children = false;
      if (kind === "stale-turn") current = false;
      const nested = control.request(
        kind === "inactive-owner" ? rejectedOwner.signal : owner.signal,
      );
      expect(nested.status).toBe(
        kind === "cached" ? "requested" : "not-applied",
      );
    });
    const receipt = control.request(owner.signal);
    control.leave(false);
    if (receipt.status !== "requested") throw new Error("missing receipt");
    expect(await receipt.completion).toMatchObject({
      status: "incomplete",
      errors: [{ resource: "children" }],
    });
    expect(cancelled).toEqual(["original"]);
  },
);

test("a new dispatch invalidates the preceding run's evidence", async () => {
  const { control, cancellations } = setup();
  control.enter();
  control.beginBackend();
  control.observeRun("previous-run");
  control.beginBackend();
  const receipt = control.request(new AbortController().signal);
  control.leave(false);
  if (receipt.status !== "requested") throw new Error("missing receipt");
  expect(await receipt.completion).toMatchObject({
    status: "incomplete",
    errors: [{ resource: "backend" }],
  });
  expect(cancellations).toHaveLength(0);
});
