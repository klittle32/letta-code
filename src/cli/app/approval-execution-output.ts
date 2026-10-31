import type { executeApprovalBatch } from "@/agent/approval-execution";
import { type Buffers, onChunk } from "@/cli/helpers/accumulator";
import type { AppendError } from "./types";

/** Publish a settled tool chunk and surface execution errors in the transcript. */
export function createApprovalExecutionOutput(
  buffers: Buffers,
  appendError: AppendError,
  refreshDerived: () => void,
): NonNullable<Parameters<typeof executeApprovalBatch>[1]> {
  return (chunk) => {
    onChunk(buffers, chunk);
    if (
      chunk.status === "error" &&
      chunk.message_type === "tool_return_message" &&
      chunk.tool_return?.startsWith("Error executing tool:")
    ) {
      appendError(chunk.tool_return, {
        errorType: "tool_execution_error",
        context: "tool_execution",
      });
    }
    refreshDerived();
  };
}
