import { expect, test } from "bun:test";
import { createModQuestionQueue } from "@/cli/mods/question-queue";
import { getQuestionFocus } from "./input-focus";

test("mod questions wait for approvals, selectors, exit, and the native reflection choice", () => {
  const queue = createModQuestionQueue("a", "c");
  void queue.ask({
    agentId: "a",
    conversationId: "c",
    owner: { id: "mod", generation: 1, path: "/mod.ts", scope: "global" },
    signal: new AbortController().signal,
    questions: [],
  });
  const options = {
    pending: queue.getSnapshot(),
    reflectionPending: false,
    showExitStats: false,
    streaming: false,
    commandRunning: true,
    isExecutingTool: false,
    pendingApprovals: [] as unknown[],
    anySelectorOpen: false,
  };
  expect(getQuestionFocus(options)).toMatchObject({
    modQuestion: options.pending,
    inputEnabled: false,
  });
  for (const blocked of [
    { pendingApprovals: [{}] },
    { anySelectorOpen: true },
    { showExitStats: true },
    { reflectionPending: true, commandRunning: false },
  ]) {
    expect(getQuestionFocus({ ...options, ...blocked }).modQuestion).toBeNull();
    expect(getQuestionFocus({ ...options, ...blocked }).inputEnabled).toBe(
      false,
    );
  }
  // Commands and pre-send/tool events can await an ask while work is active.
  expect(
    getQuestionFocus({ ...options, streaming: true, isExecutingTool: true })
      .modQuestion,
  ).toBe(options.pending);
  queue.dispose();
  expect(getQuestionFocus({ ...options, pending: null }).inputEnabled).toBe(
    true,
  );
});
