import { describe, expect, test } from "bun:test";
import { createTurnInterruptController } from "./turn-interrupt";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const turn = {
  id: "turn-1",
  agentId: "agent-1",
  conversationId: "conversation-1",
};

describe("exact turn interruption", () => {
  test("rejects stale turn and disposed mod handles before any side effect", () => {
    let aborts = 0;
    let current = false;
    const owner = new AbortController();
    const controller = createTurnInterruptController({
      turn,
      isCurrent: () => current,
      abort: () => {
        aborts += 1;
      },
      settlement: {},
    });
    expect(controller.request(owner.signal)).toEqual({
      status: "not-applied",
      reason: "stale-turn",
    });
    current = true;
    owner.abort();
    expect(controller.request(owner.signal)).toEqual({
      status: "not-applied",
      reason: "inactive-owner",
    });
    expect(aborts).toBe(0);
  });

  test("captures the exact turn and requests abort synchronously once", async () => {
    let aborts = 0;
    let current = true;
    const done = deferred();
    const owner = new AbortController();
    const controller = createTurnInterruptController({
      turn,
      isCurrent: () => current,
      abort: () => {
        aborts += 1;
      },
      settlement: { owner: () => done.promise },
    });
    const first = controller.request(owner.signal, "taken over");
    const duplicate = controller.request(owner.signal, "duplicate");
    expect(aborts).toBe(1);
    expect(duplicate).toBe(first);
    expect(first.status).toBe("requested");
    if (first.status !== "requested") throw new Error("Expected receipt");
    current = false;
    owner.abort();
    done.resolve();
    expect(await first.completion).toEqual({ status: "settled", turn });
    expect(controller.request(new AbortController().signal)).toEqual({
      status: "not-applied",
      reason: "stale-turn",
    });
    expect(aborts).toBe(1);
  });

  test("does not confuse owner completion with tools or children stopping", async () => {
    const tools = deferred();
    const children = deferred();
    const controller = createTurnInterruptController({
      turn,
      isCurrent: () => true,
      abort: () => {},
      settlement: {
        owner: async () => {},
        backend: async () => {},
        tools: () => tools.promise,
        children: () => children.promise,
      },
    });
    const receipt = controller.request(new AbortController().signal);
    if (receipt.status !== "requested") throw new Error("Expected receipt");
    expect(await receipt.wait(1)).toEqual({
      status: "incomplete",
      turn,
      pending: ["tools", "children"],
      errors: [],
    });
    tools.resolve();
    children.resolve();
    expect(await receipt.completion).toEqual({ status: "settled", turn });
    expect(await receipt.wait(100)).toEqual({ status: "settled", turn });
  });

  test("reentrant abort listeners receive the same receipt without a second abort", async () => {
    let aborts = 0;
    const owner = new AbortController();
    let reentrant: unknown;
    const controller = createTurnInterruptController({
      turn,
      isCurrent: () => true,
      abort: () => {
        aborts += 1;
        reentrant = controller.request(owner.signal);
      },
      settlement: {},
    });
    const receipt = controller.request(owner.signal);
    expect(reentrant).toBe(receipt);
    expect(aborts).toBe(1);
    if (receipt.status !== "requested") throw new Error("Expected receipt");
    expect(await receipt.completion).toEqual({ status: "settled", turn });
  });

  test("retains its own immutable identity and does not share state with another turn", async () => {
    const mutableTurn = { ...turn };
    const owner = new AbortController();
    let firstAborts = 0;
    let secondAborts = 0;
    const first = createTurnInterruptController({
      turn: mutableTurn,
      isCurrent: () => true,
      abort: () => {
        firstAborts += 1;
      },
      settlement: {},
    });
    const second = createTurnInterruptController({
      turn: { ...turn, id: "turn-2" },
      isCurrent: () => true,
      abort: () => {
        secondAborts += 1;
      },
      settlement: {},
    });
    mutableTurn.id = "replacement";
    const receipt = first.request(owner.signal);
    if (receipt.status !== "requested") throw new Error("Expected receipt");
    expect(receipt.turn).toEqual(turn);
    expect(Object.isFrozen(receipt.turn)).toBe(true);
    expect(firstAborts).toBe(1);
    expect(secondAborts).toBe(0);
    expect(second.request(owner.signal).status).toBe("requested");
    expect(secondAborts).toBe(1);
  });

  test("reports abort and settlement errors without widening cancellation", async () => {
    const calls: string[] = [];
    const controller = createTurnInterruptController({
      turn,
      isCurrent: () => true,
      abort: () => {
        throw new Error("abort failed");
      },
      settlement: {
        backend: async () => {
          calls.push("exact backend only");
          throw new Error("backend unavailable");
        },
        tools: async () => {
          calls.push("tools");
        },
      },
    });
    const receipt = controller.request(new AbortController().signal);
    if (receipt.status !== "requested") throw new Error("Expected receipt");
    const result = await receipt.completion;
    expect(result).toEqual({
      status: "incomplete",
      turn,
      pending: [],
      errors: [
        { resource: "abort", message: "abort failed" },
        { resource: "backend", message: "backend unavailable" },
      ],
    });
    expect(calls).toEqual(["exact backend only", "tools"]);
  });

  test("treats missing settlement coverage as incomplete, not proof of stop", async () => {
    const controller = createTurnInterruptController({
      turn,
      isCurrent: () => true,
      abort: () => {},
      settlement: { owner: async () => {} },
      unavailable: ["children"],
    });
    const receipt = controller.request(new AbortController().signal);
    if (receipt.status !== "requested") throw new Error("Expected receipt");
    expect(await receipt.completion).toEqual({
      status: "incomplete",
      turn,
      pending: ["children"],
      errors: [],
    });
  });

  test("rejects invalid wait deadlines and keeps the accepted work alive", async () => {
    const done = deferred();
    const controller = createTurnInterruptController({
      turn,
      isCurrent: () => true,
      abort: () => {},
      settlement: { owner: () => done.promise },
    });
    const receipt = controller.request(new AbortController().signal);
    if (receipt.status !== "requested") throw new Error("Expected receipt");
    await expect(receipt.wait(0)).rejects.toThrow("positive finite");
    await expect(receipt.wait(Number.NaN)).rejects.toThrow("positive finite");
    done.resolve();
    expect(await receipt.completion).toEqual({ status: "settled", turn });
  });
});
