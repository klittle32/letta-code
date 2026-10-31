import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { ComponentProps } from "react";
import stripAnsi from "strip-ansi";
import { InlineQuestionApproval } from "./InlineQuestionApproval";

class CaptureStream extends Writable {
  columns = 100;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

type QuestionsProp = ComponentProps<typeof InlineQuestionApproval>["questions"];

async function renderWithQuestions(
  questions: QuestionsProp,
  submit = false,
  onSubmit: (answers: Record<string, string>) => void = () => {},
  inputs: string[] = ["\r"],
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    const instance = render(
      <InlineQuestionApproval
        questions={questions}
        onSubmit={onSubmit}
        isFocused={submit}
      />,
      {
        stdout,
        stdin,
        debug: false,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    if (submit) {
      for (const input of inputs) {
        stdin.push(input);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    instance.unmount();
    instance.cleanup();
    return stripAnsi(stdout.chunks.join(""));
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function renderQuestion(question: string): Promise<string> {
  return renderWithQuestions([
    {
      header: "Review plan",
      question,
      options: [
        { label: "Approve", description: "Proceed" },
        { label: "Revise", description: "Keep planning" },
      ],
      multiSelect: false,
      allowOther: false,
    },
  ]);
}

test("InlineQuestionApproval renders multiline markdown question text", async () => {
  const output = await renderQuestion(
    [
      "# Plan",
      "",
      "- Update `InlineQuestionApproval`",
      "- Keep options unchanged",
    ].join("\n"),
  );

  expect(output).toContain("Plan");
  expect(output).not.toContain("# Plan");
  expect(output).toContain("- Update InlineQuestionApproval");
  expect(output).toContain("Approve");
  expect(output).toContain("Revise");
});

test("InlineQuestionApproval coerces non-array `options` instead of throwing (defense-in-depth)", async () => {
  // Regression: a malformed AskUserQuestion payload can carry `options` as a
  // non-iterable value (e.g. {} or a number). Spreading it would throw
  // "...iterable not be null or undefined" / "object is not iterable" and brick
  // the TUI. The component must coerce to an empty array and keep rendering.
  const renderWithOptions = (options: unknown) =>
    renderWithQuestions([
      {
        header: "H",
        question: "Q?",
        options,
        multiSelect: false,
      },
    ] as QuestionsProp);

  for (const bad of [undefined, null, { a: 1 }, 42, "nope"]) {
    const output = await renderWithOptions(bad);
    expect(output).toContain("Q?");
    expect(output).toContain("Type something.");
    expect(output).not.toContain("ERROR");
  }

  // An `options` array containing null/non-object entries must not throw when
  // the render path reads option.label/option.description. The component
  // filters out non-object entries (and non-string label/description) as
  // defense-in-depth.
  const renderWithEntries = (options: unknown) =>
    renderWithQuestions([
      {
        header: "H",
        question: "Q?",
        options,
        multiSelect: false,
      },
    ] as QuestionsProp);
  for (const badEntries of [
    [null],
    [42],
    [null, { label: "A", description: "" }],
    [{ label: "A", description: "" }, "bad"],
    // Object entries with non-string label/description would throw when
    // rendered as React children / used as a key — the filter drops them.
    [
      { label: {}, description: "" } as unknown as {
        label: string;
        description: string;
      },
    ],
    [
      { label: "A", description: {} } as unknown as {
        label: string;
        description: string;
      },
    ],
  ]) {
    const output = await renderWithEntries(badEntries);
    expect(output).toContain("Q?");
    expect(output).toContain("Type something.");
    expect(output).not.toContain("ERROR");
  }
});

test("InlineQuestionApproval renders and submits a single choice when multiSelect is omitted", async () => {
  let answers: Record<string, string> | undefined;
  const output = await renderWithQuestions(
    [
      {
        question: "Choose?",
        header: "Choice",
        options: [
          { label: "A", description: "First" },
          { label: "B", description: "Second" },
        ],
      },
    ],
    true,
    (value) => {
      answers = value;
    },
  );
  expect(output).toContain("Choose?");
  expect(output).not.toContain("Run AskUserQuestion?");
  expect(output).not.toContain("ERROR");
  expect(answers).toEqual({ "Choose?": "A" });
});

for (const [name, chunk, expected] of [
  ["full input chunk", "Custom local choice", "Custom local choice"],
  [
    "join link",
    "https://example.com/join?invite=123",
    "https://example.com/join?invite=123",
  ],
  ["Unicode chunk", "Zoë 👩🏽‍💻 é", "Zoë 👩🏽‍💻 é"],
  [
    "bracketed paste",
    "\u001b[200~invite@example.com\nhttps://example.com/join\u001b[201~",
    "invite@example.com https://example.com/join",
  ],
] as const) {
  test(`custom answer accepts ${name} through native Ink stdin`, async () => {
    let answers: Record<string, string> | undefined;
    await renderWithQuestions(
      [
        {
          header: "Choice",
          question: "Choose?",
          options: [{ label: "A", description: "" }],
        },
      ],
      true,
      (value) => {
        answers = value;
      },
      ["\u001b[B", chunk, "\r"],
    );
    expect(answers).toEqual({ "Choose?": expected });
  });
}

for (const multiSelect of [false, true]) {
  test(`chunk insertion preserves editing and selection (multiSelect=${multiSelect})`, async () => {
    let answers: Record<string, string> | undefined;
    await renderWithQuestions(
      [
        {
          header: "Choice",
          question: "Choose?",
          multiSelect,
          options: [{ label: "A", description: "" }],
        },
      ],
      true,
      (value) => {
        answers = value;
      },
      [
        // Numbers still select/toggle regular options outside custom input.
        ...(multiSelect ? ["1"] : []),
        "\u001b[B",
        "discard me",
        "\u001b", // first Escape clears custom text rather than cancelling
        "ab",
        "\u001b[D",
        "12👩🏽‍💻é",
        "\u0001", // Ctrl+A must not insert text
        "\u001bx", // Meta+X must not insert text
        "\u001b[C",
        "\u007f", // backspace removes b, leaving the Unicode chunk intact
        "\u001b[200~@example.com\u001b[201~",
        "\r",
        ...(multiSelect ? ["\u001b[B", "\r"] : []),
      ],
    );
    expect(answers).toEqual({
      "Choose?": `${multiSelect ? "A, " : ""}a12👩🏽‍💻é@example.com`,
    });
  });
}

test("number shortcut still submits a regular single choice", async () => {
  let answers: Record<string, string> | undefined;
  await renderWithQuestions(
    [
      {
        header: "Choice",
        question: "Choose?",
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
    ],
    true,
    (value) => {
      answers = value;
    },
    ["2"],
  );
  expect(answers).toEqual({ "Choose?": "B" });
});
