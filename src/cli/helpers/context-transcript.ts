import type {
  ContextPlacement,
  HumanContextEntry,
} from "@/agent/context-inbox";
import type { Buffers, Line } from "./accumulator";
export type PositionedContext = HumanContextEntry & { id: string };
export type ContextLine = {
  kind: "context";
  id: string;
  text: string;
  unavailableAnchor: boolean;
};
type BoundaryLine = {
  kind: string;
  id: string;
  otid?: string;
  messageId?: string;
  toolCallId?: string;
};
/** A message boundary, not a fragment position. Prefer known OTID/message aliases. */
export function transcriptBoundary(
  lines: readonly BoundaryLine[],
  aliases?: Pick<
    Buffers,
    "assistantCanonicalByOtid" | "reasoningCanonicalByOtid"
  >,
): ContextPlacement | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = lines[i];
    if (
      !row ||
      !["user", "assistant", "reasoning", "tool_call"].includes(row.kind)
    )
      continue;
    const map =
      row.kind === "assistant"
        ? aliases?.assistantCanonicalByOtid
        : row.kind === "reasoning"
          ? aliases?.reasoningCanonicalByOtid
          : undefined;
    const otid =
      row.otid ??
      [...(map?.entries() ?? [])].find(
        ([, canonical]) => canonical === row.id,
      )?.[0];
    if (row.kind === "tool_call" && row.toolCallId)
      return { after: { toolCallId: row.toolCallId } };
    if (otid || row.messageId)
      return {
        after: {
          ...(otid ? { otid } : {}),
          ...(row.messageId ? { messageId: row.messageId } : {}),
        },
      };
  }
  return undefined; // Host can obtain the last canonical boundary through captured history.
}
export function mergeContextTranscript<T extends BoundaryLine>(
  lines: readonly T[],
  entries: readonly PositionedContext[],
): (T | ContextLine)[] {
  const before: ContextLine[] = [];
  const after = new Map<number, ContextLine[]>();
  const seen = new Set<string>();
  for (const entry of [...entries].sort(
    (a, b) => a.record.sequence - b.record.sequence,
  )) {
    if (seen.has(entry.id) || lines.some((row) => row.id === entry.id))
      continue;
    seen.add(entry.id);
    const anchor = entry.placement?.after;
    let index = -1;
    if (anchor) {
      const canonical =
        anchor.messageId &&
        lines.some(
          (row) =>
            row.messageId === anchor.messageId || row.id === anchor.messageId,
        );
      const tool =
        anchor.toolCallId &&
        lines.some((row) => row.toolCallId === anchor.toolCallId);
      for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        if (
          row &&
          (tool
            ? row.toolCallId === anchor.toolCallId
            : canonical
              ? row.messageId === anchor.messageId ||
                row.id === anchor.messageId
              : anchor.toolCallId
                ? row.toolCallId === anchor.toolCallId
                : anchor.otid &&
                  (row.otid === anchor.otid || row.id === anchor.otid))
        )
          index = i;
      }
    }
    const row: ContextLine = {
      kind: "context",
      id: entry.id,
      text: entry.record.text,
      unavailableAnchor:
        entry.placement === null || (anchor !== null && index < 0),
    };
    if (index < 0) before.push(row);
    else {
      const group = after.get(index) ?? [];
      group.push(row);
      after.set(index, group);
    }
  }
  const prefix = lines.findIndex((row) =>
    ["user", "assistant", "reasoning", "tool_call"].includes(row.kind),
  );
  const boundary = prefix < 0 ? lines.length : prefix;
  return [
    ...lines.slice(0, boundary),
    ...before,
    ...lines
      .slice(boundary)
      .flatMap((row, index) => [row, ...(after.get(index + boundary) ?? [])]),
  ];
}
/** Restrict this utility to presentation rows; these never enter Buffers/model exports. */
export type ContextDisplayLine = Line | ContextLine;
