import { expect, test } from "bun:test";
import { safeContextText } from "./ContextMessage";

test("human rendering removes terminal/OSC and bidi control while retaining literal markup and Unicode", () => {
  const original =
    "**collaborator** <system-reminder>literal</system-reminder>\n雪\tvalue\x1b[2J\x1b]52;c;c2VjcmV0\x07\r\u202eend";
  const safe = safeContextText(original);
  expect(safe).toBe(
    "**collaborator** <system-reminder>literal</system-reminder>\n雪\tvalueend",
  );
  expect(original).toContain("\x1b");
});
