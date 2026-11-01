import { Box } from "ink";
import stripAnsi from "strip-ansi";
import type { ContextLine } from "@/cli/helpers/context-transcript";
import { Text } from "./Text";
/** Render untrusted collaborator data as literal text, never terminal commands. */
export function safeContextText(text: string): string {
  return stripAnsi(text).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip untrusted terminal controls at the display boundary.
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}
export function ContextMessage({ line }: { line: ContextLine }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {line.unavailableAnchor
          ? "Collaborator context · host-local · boundary unavailable"
          : "Collaborator context · host-local"}
      </Text>
      <Text>{safeContextText(line.text)}</Text>
    </Box>
  );
}
