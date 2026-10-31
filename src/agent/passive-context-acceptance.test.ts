import { expect, test } from "bun:test";
import type { ContextSubmission } from "./context-inbox";
import { createPassiveContextAcceptance } from "./passive-context-acceptance";

const binding: ContextSubmission = {
  id: "human-otid",
  outcome: "uncertain",
  contextMessageOtid: "context-otid",
  requestFingerprint: null,
  records: [
    {
      id: "remote-1",
      text: "Shared activity",
      visibility: "both",
      storage: "host-local",
      sequence: 1,
    },
  ],
};
const context = {
  message_type: "user_message",
  id: "stored-context",
  otid: binding.contextMessageOtid,
};
const human = {
  message_type: "user_message",
  id: "stored-human",
  otid: binding.id,
};

test("accepts only ordered canonical context and explicit human rows, once", () => {
  const evidence = createPassiveContextAcceptance(binding);
  expect(evidence.observe(context)).toBe(false);
  expect(evidence.accepted).toBe(false);
  expect(evidence.observe(human)).toBe(true);
  expect(evidence.accepted).toBe(true);
  expect(evidence.observe(human)).toBe(false);
});

for (const row of [
  { message_type: "stop_reason", stop_reason: "end_turn" },
  { message_type: "error_message", message: "interrupted" },
  { status: "completed", id: "run-id" },
  { ...context, message_type: "assistant_message" },
  { ...context, id: "" },
  { ...context, otid: "unrelated" },
]) {
  test(`noncanonical or unrelated evidence cannot acknowledge delivery: ${JSON.stringify(row)}`, () => {
    const evidence = createPassiveContextAcceptance(binding);
    expect(evidence.observe(row)).toBe(false);
    expect(evidence.observe(human)).toBe(false);
    expect(evidence.accepted).toBe(false);
  });
}

test("a human row preceding context cannot be reordered by repeated stream chunks", () => {
  const evidence = createPassiveContextAcceptance(binding);
  evidence.observe(human);
  evidence.observe(context);
  evidence.observe(human);
  expect(evidence.accepted).toBe(false);
});

test("one canonical row cannot represent both context and human input", () => {
  const evidence = createPassiveContextAcceptance(binding);
  evidence.observe(context);
  evidence.observe({ ...human, id: context.id });
  expect(evidence.accepted).toBe(false);
});

test("a request with no selected context requires only its canonical human row", () => {
  const evidence = createPassiveContextAcceptance({ ...binding, records: [] });
  expect(evidence.observe({ ...human, id: undefined })).toBe(false);
  expect(evidence.observe(human)).toBe(true);
});

test("captures the binding identities rather than retaining mutable caller state", () => {
  const copy = structuredClone(binding);
  const evidence = createPassiveContextAcceptance(copy);
  copy.id = "replacement-human";
  copy.contextMessageOtid = "replacement-context";
  copy.records.length = 0;
  expect(evidence.observe(context)).toBe(false);
  expect(evidence.observe(human)).toBe(true);
});

test("mutating a selected record list cannot remove the context-evidence requirement", () => {
  const copy = structuredClone(binding);
  const evidence = createPassiveContextAcceptance(copy);
  copy.records.length = 0;
  expect(evidence.observe(human)).toBe(false);
  expect(evidence.accepted).toBe(false);
});

test("rejects ambiguous context/human submission identities", () => {
  expect(() =>
    createPassiveContextAcceptance({
      ...binding,
      contextMessageOtid: binding.id,
    }),
  ).toThrow();
});
