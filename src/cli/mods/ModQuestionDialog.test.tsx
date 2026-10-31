import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { Box, render, useInput } from "ink";
import { useEffect, useState } from "react";
import type { ModQuestionRequest } from "@/mods/question-api";
import type { ModAskResult } from "@/mods/types";
import { ModQuestionDialog } from "./ModQuestionDialog";
import { useModQuestions } from "./use-mod-questions";

class Capture extends Writable {
  columns = 80;
  rows = 40;
  isTTY = true;
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: () => void,
  ) {
    callback();
  }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

test("native dialog single/multi/Other/dismissal; input remains mounted and Enter has one owner", async () => {
  for (const kind of [
    "single",
    "multi",
    "other",
    "paste",
    "dismiss",
  ] as const) {
    let answer: ModAskResult | undefined;
    let mainEnters = 0;
    let mounts = 0;
    const request: ModQuestionRequest = {
      agentId: "a",
      conversationId: "c",
      signal: new AbortController().signal,
      owner: { id: "mod", generation: 1, path: "/mod.ts", scope: "global" },
      questions: [
        {
          question: "Pick?",
          header: "Pick",
          multiSelect: kind === "multi",
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    };
    function MainInput({ enabled }: { enabled: boolean }) {
      useEffect(() => {
        mounts++;
      }, []);
      useInput(
        (_input, key) => {
          if (enabled && key.return) mainEnters++;
        },
        { isActive: enabled },
      );
      return null;
    }
    function Harness() {
      const host = useModQuestions("a", "c");
      const [blocked, setBlocked] = useState(true);
      useEffect(() => {
        void host.ask(request).then((result) => {
          answer = result;
        });
      }, [host.ask]);
      useInput((input) => {
        if (input === "x") setBlocked(false);
      });
      const pending = blocked ? null : host.pending;
      return (
        <Box flexDirection="column">
          <ModQuestionDialog pending={pending} />
          <MainInput enabled={!pending && !blocked} />
        </Box>
      );
    }
    const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    const output = new Capture() as Capture & NodeJS.WriteStream;
    const instance = render(<Harness />, {
      stdin,
      stdout: output,
      stderr: output,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    try {
      await pause();
      stdin.push("\r");
      await pause(); // higher priority host UI owns focus
      expect(answer).toBeUndefined();
      stdin.push("x");
      await pause();
      if (kind === "single") stdin.push("\r");
      if (kind === "dismiss") stdin.push("\u001b");
      if (kind === "other" || kind === "paste") {
        stdin.push("\u001b[B");
        await pause();
        stdin.push("\u001b[B");
        await pause();
        stdin.push(
          kind === "paste"
            ? "\u001b[200~invite@example.com https://example.com/join\u001b[201~"
            : "Custom local choice",
        );
        await pause();
        stdin.push("\r");
      }
      if (kind === "multi") {
        stdin.push("1");
        await pause();
        stdin.push("2");
        await pause();
        for (let i = 0; i < 3; i++) {
          stdin.push("\u001b[B");
          await pause();
        }
        stdin.push("\r");
      }
      await pause();
      expect(answer).toEqual(
        kind === "dismiss"
          ? { status: "dismissed", reason: "cancelled" }
          : {
              status: "answered",
              answers: {
                "Pick?":
                  kind === "multi"
                    ? "A, B"
                    : kind === "other"
                      ? "Custom local choice"
                      : kind === "paste"
                        ? "invite@example.com https://example.com/join"
                        : "A",
              },
            },
      );
      expect(mainEnters).toBe(0);
      expect(mounts).toBe(1);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  }
});
