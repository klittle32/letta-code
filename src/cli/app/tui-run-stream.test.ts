import { expect, test } from "bun:test";
import { observeTuiRunStream } from "./tui-run-stream";

test("observes only the exact stream's IDs and preserves cancellation controller", async () => {
  const seen: (string | undefined)[] = [];
  const controller = new AbortController();
  const stream = {
    controller,
    async *[Symbol.asyncIterator]() {
      yield { run_id: "exact" };
      yield { text: "content" };
    },
  };
  const wrapped = observeTuiRunStream(stream, (id) => seen.push(id));
  const chunks = [];
  for await (const chunk of wrapped) chunks.push(chunk);
  expect(wrapped).toBe(stream); // Recovery metadata is keyed by stream identity.
  expect(wrapped.controller).toBe(controller);
  expect(seen).toEqual(["exact", undefined]);
  expect(chunks).toHaveLength(2);
});

test("normal approval terminal retains exact run evidence through tool execution", async () => {
  const seen: (string | undefined)[] = [];
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield {
        run_id: "approval-run",
        message_type: "approval_request_message",
      };
      yield { message_type: "stop_reason", stop_reason: "requires_approval" };
    },
  };
  for await (const _chunk of observeTuiRunStream(stream, (id) =>
    seen.push(id),
  )) {
    /* drain */
  }
  expect(seen).toHaveLength(1);
  expect(seen).toEqual(["approval-run"]);
});

test.each(["throw", "error-terminal", "early-return"])(
  "%s invalidates evidence before an unobserved resume",
  async (kind) => {
    const seen: (string | undefined)[] = [];
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { run_id: "old" };
        if (kind === "throw") throw new Error("transport lost");
        yield { message_type: "stop_reason", stop_reason: "error" };
      },
    };
    try {
      for await (const _chunk of observeTuiRunStream(stream, (id) =>
        seen.push(id),
      )) {
        if (kind === "early-return") break;
      }
    } catch {
      /* expected transport error */
    }
    expect(seen.at(-1)).toBeUndefined();
  },
);
