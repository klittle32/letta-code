import { expect, test } from "bun:test";
import {
  mergeContextTranscript,
  transcriptBoundary,
} from "./context-transcript";

const entry = {
  id: "context:namespace:r",
  record: {
    id: "r",
    text: "remote",
    visibility: "both" as const,
    storage: "host-local" as const,
    sequence: 1,
  },
  placement: { after: { otid: "human-otid", messageId: "server-human" } },
};
test("boundary aliases survive resume and both merges once", () => {
  const live = [
    {
      kind: "user" as const,
      id: "human-otid",
      text: "hello",
      otid: "human-otid",
    },
  ];
  expect(transcriptBoundary(live)).toEqual({ after: { otid: "human-otid" } });
  expect(mergeContextTranscript(live, [entry, entry]).map((r) => r.id)).toEqual(
    ["human-otid", entry.id],
  );
  const resumed = [
    {
      kind: "user" as const,
      id: "server-human",
      messageId: "server-human",
      text: "hello",
    },
  ];
  expect(mergeContextTranscript(resumed, [entry]).map((r) => r.id)).toEqual([
    "server-human",
    entry.id,
  ]);
});
test("clipped anchors stay honestly labelled before loaded tail, never silently at its end", () => {
  const rows = mergeContextTranscript(
    [
      {
        kind: "assistant" as const,
        id: "new",
        messageId: "new",
        text: "later",
        phase: "finished" as const,
      },
    ],
    [entry],
  );
  expect(rows.map((r) => r.id)).toEqual([entry.id, "new"]);
  expect(rows[0]).toMatchObject({ kind: "context", unavailableAnchor: true });
});
test("whole-message boundary follows all split fragments, never the first fragment", () => {
  const rows = [
    {
      kind: "assistant" as const,
      id: "a-split-0",
      messageId: "msg-a",
      phase: "finished" as const,
      text: "first",
    },
    {
      kind: "assistant" as const,
      id: "a",
      messageId: "msg-a",
      phase: "streaming" as const,
      text: "last",
    },
  ];
  const e = { ...entry, placement: { after: { messageId: "msg-a" } } };
  expect(mergeContextTranscript(rows, [e]).map((r) => r.id)).toEqual([
    "a-split-0",
    "a",
    entry.id,
  ]);
});

test("known streaming OTID aliases take precedence over earlier human boundary", () => {
  const lines = [
    { kind: "user", id: "human", otid: "human", text: "hello" },
    { kind: "assistant", id: "canonical", text: "active" },
  ];
  expect(
    transcriptBoundary(lines, {
      assistantCanonicalByOtid: new Map([["assistant-otid", "canonical"]]),
      reasoningCanonicalByOtid: new Map(),
    }),
  ).toEqual({ after: { otid: "assistant-otid" } });
});

test("canonical message boundary wins when a backend reuses an OTID on later rows", () => {
  const rows = [
    {
      kind: "assistant",
      id: "first",
      messageId: "message-first",
      otid: "reused",
    },
    {
      kind: "assistant",
      id: "later",
      messageId: "message-later",
      otid: "reused",
    },
  ];
  expect(
    mergeContextTranscript(rows, [
      {
        ...entry,
        placement: { after: { messageId: "message-first", otid: "reused" } },
      },
    ]).map((row) => row.id),
  ).toEqual(["first", entry.id, "later"]);
});

test("stable tool-call identity resolves live and resumed message aliases", () => {
  const live = [{ kind: "tool_call", id: "tool-id", toolCallId: "tool-id" }];
  expect(transcriptBoundary(live)).toEqual({
    after: { toolCallId: "tool-id" },
  });
  const context = {
    ...entry,
    placement: { after: { messageId: "raw-call", toolCallId: "tool-id" } },
  };
  for (const rows of [
    live,
    [{ kind: "tool_call", id: "call-otid", toolCallId: "tool-id" }],
  ]) {
    expect(mergeContextTranscript(rows, [context])).toEqual([
      ...rows,
      {
        kind: "context",
        id: entry.id,
        text: "remote",
        unavailableAnchor: false,
      },
    ]);
  }
});

test("parallel tool message placement follows the last stable tool identity", () => {
  const rows = [
    { kind: "tool_call", id: "raw-call", toolCallId: "first" },
    { kind: "tool_call", id: "raw-call-last", toolCallId: "last" },
  ];
  const context = {
    ...entry,
    placement: { after: { messageId: "raw-call", toolCallId: "last" } },
  };
  expect(mergeContextTranscript(rows, [context]).map((row) => row.id)).toEqual([
    "raw-call",
    "raw-call-last",
    entry.id,
  ]);
});
