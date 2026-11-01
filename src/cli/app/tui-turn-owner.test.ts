import { expect, test } from "bun:test";
import { clearSubagentsByIds, registerSubagent } from "@/agent/subagent-state";
import { __testSetBackend, type Backend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { createAssistantMessageStream } from "@/backend/dev/headless-turn-executor";
import { buildModInvocationContext } from "@/mods/context";
import { bindModTurnHandle } from "@/mods/turn-handle";
import {
  attachTuiTurnContext,
  enterTuiLogicalTurn,
  isTuiApprovalContinuation,
  snapshotTuiModContext,
} from "./tui-turn-owner";

test("approval continuation retains ownership; replacement and late events cannot retarget", () => {
  const ref = { current: null as AbortController | null };
  const generationRef = { current: 0 };
  const options = {
    ref,
    generationRef,
    generation: 0,
    continuation: false,
    agentId: "agent",
    conversationId: "conversation",
  };
  const first = enterTuiLogicalTurn(options);
  const context = buildModInvocationContext({
    agent: { id: "agent" },
    conversationId: "conversation",
  });
  attachTuiTurnContext(context, ref);
  const snapshot = snapshotTuiModContext(context);
  const handle = bindModTurnHandle(
    snapshot?.turn,
    new AbortController().signal,
  );
  first.leave(true);
  const continuation = enterTuiLogicalTurn({ ...options, continuation: true });
  expect(continuation).toBe(first);
  continuation.leave(false);
  const second = enterTuiLogicalTurn(options);
  expect(second.turn.id).not.toBe(first.turn.id);
  expect(handle?.requestInterrupt()).toEqual({
    status: "not-applied",
    reason: "stale-turn",
  });
  expect(second.signal.aborted).toBe(false);
  expect(snapshot?.turn?.id).toBe(first.turn.id);
  second.leave(false);
});

test("cancelled approval resume stays fenced rather than allocating a new turn", () => {
  const ref = { current: null as AbortController | null };
  const options = {
    ref,
    generationRef: { current: 0 },
    generation: 0,
    continuation: false,
    agentId: "agent",
    conversationId: "conversation",
  };
  const first = enterTuiLogicalTurn(options);
  first.leave(true);
  first.request(new AbortController().signal);
  const resumed = enterTuiLogicalTurn({ ...options, continuation: true });
  expect(resumed).toBe(first);
  expect(resumed.signal.aborted).toBe(true);
  resumed.leave(false);
});

test("continuation cannot inherit a different agent's controller", () => {
  const ref = { current: null as AbortController | null };
  const options = {
    ref,
    generationRef: { current: 0 },
    generation: 0,
    continuation: false,
    agentId: "first-agent",
    conversationId: "shared-id",
  };
  const first = enterTuiLogicalTurn(options);
  first.leave(true);
  const second = enterTuiLogicalTurn({
    ...options,
    agentId: "second-agent",
    continuation: true,
  });
  expect(second).not.toBe(first);
  expect(second.turn.agentId).toBe("second-agent");
  second.leave(false);
});

test.each(["other", "same", "unowned"])(
  "background child %s remains independent of parent interruption",
  async (scope) => {
    const childId = `child-scope-${scope}`;
    registerSubagent(
      childId,
      "test",
      "child",
      undefined,
      true,
      false,
      scope === "unowned"
        ? undefined
        : {
            agentId: "agent",
            conversationId: scope === "same" ? "conversation" : "elsewhere",
          },
    );
    try {
      const control = enterTuiLogicalTurn({
        ref: { current: null },
        generationRef: { current: 0 },
        generation: 0,
        continuation: false,
        agentId: "agent",
        conversationId: "conversation",
      });
      const receipt = control.request(new AbortController().signal);
      control.leave(false);
      if (receipt.status !== "requested") throw new Error("missing receipt");
      expect((await receipt.completion).status).toBe("settled");
    } finally {
      clearSubagentsByIds([childId]);
    }
  },
);

test("backend cancellation ACK alone cannot claim stopped side effects", async () => {
  const backend: Backend = new FakeHeadlessBackend("agent", {
    async execute() {
      return createAssistantMessageStream();
    },
  });
  const ids: string[] = [];
  backend.cancelRun = async (_agentId, id) => {
    ids.push(id);
    return { [id]: "cancelled" };
  };
  backend.retrieveRun = async (id) => ({
    id,
    agent_id: "agent",
    status: "running",
  });
  __testSetBackend(backend);
  try {
    const control = enterTuiLogicalTurn({
      ref: { current: null },
      generationRef: { current: 0 },
      generation: 0,
      continuation: false,
      agentId: "agent",
      conversationId: "conversation",
    });
    control.beginBackend();
    control.observeRun("exact");
    const receipt = control.request(new AbortController().signal);
    control.leave(false);
    if (receipt.status !== "requested") throw new Error("missing receipt");
    expect(await receipt.completion).toMatchObject({
      status: "incomplete",
      errors: [{ resource: "backend" }],
    });
    expect(ids).toEqual(["exact"]);
  } finally {
    __testSetBackend(null);
  }
});

test("fresh user input carrying saved results does not resume the aborted owner", () => {
  expect(isTuiApprovalContinuation([{ type: "approval", approvals: [] }])).toBe(
    true,
  );
  expect(
    isTuiApprovalContinuation([
      { type: "approval", approvals: [] },
      { type: "message", role: "user", content: "queued input" },
    ]),
  ).toBe(false);
});

test.each(["completed", "failed", "cancelled"] as const)(
  "recorded %s establishes host-observable backend settlement",
  async (status) => {
    const backend: Backend = new FakeHeadlessBackend("agent", {
      async execute() {
        return createAssistantMessageStream();
      },
    });
    const retrieved: string[] = [];
    backend.cancelRun = async (_agent, id) => ({ [id]: "failed" });
    backend.retrieveRun = async (id) => {
      retrieved.push(id);
      return { id, agent_id: "agent", status };
    };
    __testSetBackend(backend);
    try {
      const control = enterTuiLogicalTurn({
        ref: { current: null },
        generationRef: { current: 0 },
        generation: 0,
        continuation: false,
        agentId: "agent",
        conversationId: "conversation",
      });
      control.beginBackend();
      control.observeRun("exact-terminal");
      const receipt = control.request(new AbortController().signal);
      control.leave(false);
      if (receipt.status !== "requested") throw new Error("missing receipt");
      expect(await receipt.completion).toMatchObject({
        status: "settled",
      });
      expect(retrieved).toEqual(["exact-terminal"]);
    } finally {
      __testSetBackend(null);
    }
  },
);

test.each(["wrong-run", "wrong-agent", "unavailable", "cancel-rejected"])(
  "exact backend evidence handles %s without widening cancellation",
  async (scenario) => {
    const backend: Backend = new FakeHeadlessBackend("agent", {
      async execute() {
        return createAssistantMessageStream();
      },
    });
    const cancellations: string[] = [];
    backend.cancelRun = async (agent, id) => {
      cancellations.push(`${agent}:${id}`);
      if (scenario === "cancel-rejected") throw new Error("already ended");
      return { [id]: "cancelled" };
    };
    backend.retrieveRun = async () => {
      if (scenario === "unavailable") throw new Error("lookup unavailable");
      return {
        id: scenario === "wrong-run" ? "replacement" : "exact",
        agent_id: scenario === "wrong-agent" ? "another-agent" : "agent",
        status: "completed",
      };
    };
    __testSetBackend(backend);
    try {
      const control = enterTuiLogicalTurn({
        ref: { current: null },
        generationRef: { current: 0 },
        generation: 0,
        continuation: false,
        agentId: "agent",
        conversationId: "conversation",
      });
      control.beginBackend();
      control.observeRun("exact");
      const receipt = control.request(new AbortController().signal);
      control.leave(false);
      if (receipt.status !== "requested") throw new Error("missing receipt");
      expect((await receipt.completion).status).toBe(
        scenario === "cancel-rejected" ? "settled" : "incomplete",
      );
      expect(cancellations).toEqual(["agent:exact"]);
    } finally {
      __testSetBackend(null);
    }
  },
);

test("captured turn cancel uses its exact run and never the ambient conversation", async () => {
  const { setTurnMessageTransport } = await import(
    "@/agent/message-transport-owner"
  );
  const { cancelTuiBackendConversation, assertTuiAutomaticRetry } =
    await import("./tui-turn-owner");
  const original: Backend = new FakeHeadlessBackend("agent", {
    async execute() {
      return createAssistantMessageStream();
    },
  });
  const ambient: Backend = new FakeHeadlessBackend("agent", {
    async execute() {
      return createAssistantMessageStream();
    },
  });
  let foreign = 0;
  const cancelled: string[] = [];
  ambient.cancelConversation = async () => {
    foreign++;
    throw new Error("wrong principal");
  };
  original.cancelRun = async (_agent, id) => {
    cancelled.push(id);
    return { [id]: "cancelled" };
  };
  __testSetBackend(original);
  const ref = { current: null as AbortController | null };
  const control = enterTuiLogicalTurn({
    ref,
    generationRef: { current: 0 },
    generation: 0,
    continuation: false,
    agentId: "agent",
    conversationId: "conversation",
  });
  try {
    setTurnMessageTransport(control.signal, original, original, "human");
    __testSetBackend(ambient);
    await expect(
      cancelTuiBackendConversation(ref, "conversation"),
    ).rejects.toThrow("no proven run identity");
    expect(() => assertTuiAutomaticRetry(ref)).toThrow(
      "automatic request replay",
    );
    control.observeRun("original-run");
    await cancelTuiBackendConversation(ref, "conversation");
    expect(cancelled).toEqual(["original-run"]);
    expect(foreign).toBe(0);
  } finally {
    await control.leave(false);
    __testSetBackend(null);
  }
});
