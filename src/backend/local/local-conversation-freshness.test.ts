import { expect, test } from "bun:test";
import { createLocalConversationRecord } from "./local-conversation-record";
import { repairSyntheticConversationTimestamps } from "./local-transcript";

test("an empty transcript's filesystem timestamp is not evidence of a message", () => {
  const fresh = createLocalConversationRecord("fresh", "agent");
  const timing = { updatedAt: "2026-10-31T12:00:00.000Z" };
  expect(
    repairSyntheticConversationTimestamps(fresh, [], timing).last_message_at,
  ).toBeNull();
  const used = repairSyntheticConversationTimestamps(
    fresh,
    [
      {
        id: "message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.parse(timing.updatedAt),
      },
    ],
    timing,
  );
  expect(used.last_message_at).toBe(timing.updatedAt);
  expect(
    repairSyntheticConversationTimestamps(
      { ...fresh, last_message_at: "2026-01-01T00:00:01.000Z" },
      [],
      timing,
    ).last_message_at,
  ).toBe(timing.updatedAt);
});
