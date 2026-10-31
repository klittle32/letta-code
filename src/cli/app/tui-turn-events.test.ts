import { expect, test } from "bun:test";
import { scheduleTuiContinuation } from "./tui-turn-events";

test("scheduled continuation is fenced if its logical turn aborts before dispatch", async () => {
  const controller = new AbortController();
  const sent: unknown[] = [];
  scheduleTuiContinuation("feedback", controller.signal, (input) => {
    sent.push(input);
  });
  controller.abort();
  await Bun.sleep(5);
  expect(sent).toEqual([]);
});
test("normal continuation retains user role and reentry", async () => {
  const sent: unknown[] = [];
  scheduleTuiContinuation(
    "feedback",
    new AbortController().signal,
    (input, options) => {
      sent.push({ input, options });
    },
  );
  await Bun.sleep(5);
  expect(sent).toEqual([
    {
      input: [
        expect.objectContaining({
          type: "message",
          role: "user",
          content: "feedback",
        }),
      ],
      options: { allowReentry: true },
    },
  ]);
});
