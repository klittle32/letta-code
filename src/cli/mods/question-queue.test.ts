import { expect, test } from "bun:test";
import type { ModQuestionRequest } from "@/mods/question-api";
import { createModQuestionQueue } from "./question-queue";

const questions = [
  {
    question: "Choose?",
    header: "Choice",
    options: [
      { label: "A", description: "First" },
      { label: "B", description: "Second" },
    ],
  },
];
function request(signal = new AbortController().signal): ModQuestionRequest {
  return {
    questions,
    signal,
    agentId: "a",
    conversationId: "c",
    owner: { id: "mod", path: "/mod.ts", scope: "global", generation: 1 },
  };
}

test("FIFO requests have distinct host IDs even for identical owner/questions; settlements remove themselves", async () => {
  const queue = createModQuestionQueue("a", "c");
  const first = queue.ask(request());
  const one = queue.getSnapshot();
  if (!one) throw new Error("Expected first question");
  const second = queue.ask(request());
  expect(queue.getSnapshot()).toBe(one);
  one.submit({ "Choose?": "A" });
  expect(await first).toEqual({
    status: "answered",
    answers: { "Choose?": "A" },
  });
  const two = queue.getSnapshot();
  if (!two) throw new Error("Expected second question");
  expect(two.id).not.toBe(one.id);
  one.dismiss(); // stale callback cannot settle the next request
  expect(queue.getSnapshot()).toBe(two);
  two.dismiss();
  expect(await second).toEqual({ status: "dismissed", reason: "cancelled" });
  expect(queue.getSnapshot()).toBeNull();
});

test("abort, disposal, and agent/conversation switches settle and remove pending requests", async () => {
  for (const mode of ["abort", "dispose", "agent", "conversation"] as const) {
    const queue = createModQuestionQueue("a", "c");
    const controller = new AbortController();
    const pending = queue.ask(request(controller.signal));
    if (mode === "abort") controller.abort();
    if (mode === "dispose") queue.dispose();
    if (mode === "agent") queue.setScope("b", "c");
    if (mode === "conversation") queue.setScope("a", "d");
    expect((await pending).status).toBe("dismissed");
    expect(queue.getSnapshot()).toBeNull();
  }
});

test("rejects old invocation scopes and already aborted requests without displaying them", async () => {
  const queue = createModQuestionQueue("b", "c");
  expect(await queue.ask(request())).toEqual({
    status: "dismissed",
    reason: "scope-changed",
  });
  queue.setScope("a", "c");
  const controller = new AbortController();
  controller.abort();
  expect((await queue.ask(request(controller.signal))).status).toBe(
    "dismissed",
  );
  expect(queue.getSnapshot()).toBeNull();
});

test("aborting a queued request leaves the focused request intact", async () => {
  const queue = createModQuestionQueue("a", "c");
  const first = queue.ask(request());
  const focused = queue.getSnapshot();
  const controller = new AbortController();
  const queued = queue.ask(request(controller.signal));
  controller.abort();
  expect(await queued).toEqual({ status: "dismissed", reason: "cancelled" });
  expect(queue.getSnapshot()).toBe(focused);
  focused?.dismiss();
  await first;
  expect(queue.getSnapshot()).toBeNull();
});
