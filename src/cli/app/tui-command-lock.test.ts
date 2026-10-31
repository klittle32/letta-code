import { expect, test } from "bun:test";
import { createTuiCommandLock } from "./tui-command-lock";

test("command completion cannot drop an activation lock; exact invocation alone is exempt", () => {
  const lock = createTuiCommandLock(() => {});
  const own = new AbortController().signal;
  const other = new AbortController().signal;
  lock.setCommand(true);
  const done = lock.enterInvocation(own);
  expect(lock.commandBlocks(own)).toBe(false);
  expect(lock.commandBlocks(other)).toBe(true);
  lock.setActivation(true);
  lock.setCommand(false);
  done();
  expect(lock.ref.current).toBe(true);
  expect(lock.activationBusy).toBe(true);
  lock.setActivation(false);
  expect(lock.ref.current).toBe(false);
});

test("initialization arrivals stay parked with original scope after the lock releases", () => {
  const lock = createTuiCommandLock(() => {});
  lock.setActivation(true, { agentId: "agent", conversationId: "source" });
  const message = {
    kind: "task_notification" as const,
    text: "finished",
    content: [{ type: "text" as const, text: "full result" }],
  };
  expect(lock.parkIncoming(message)).toEqual({
    ...message,
    agentId: "agent",
    conversationId: "source",
  });
  lock.setActivation(false);
  expect(lock.parkedMessages).toEqual([
    { ...message, agentId: "agent", conversationId: "source" },
  ]);
  expect(lock.parkIncoming(message)).toBeUndefined();
});
