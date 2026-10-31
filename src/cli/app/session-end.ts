import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { runSessionEndHooks } from "@/hooks";
import type { ModConversationCloseReason } from "@/mods/types";
import { telemetry } from "@/telemetry";

/** Ordinary exits remain best-effort; trusted activation surfaces source failures. */
export async function endTuiSession(
  agentId: string,
  conversationId: string,
  durationMs: number,
  adapter: LocalModAdapter | null,
  reason: ModConversationCloseReason = "quit",
  strict = false,
): Promise<void> {
  try {
    const result = await runSessionEndHooks(
      durationMs,
      undefined,
      undefined,
      agentId,
      conversationId,
    );
    if (strict && (result.errored || result.blocked))
      throw new Error("Source SessionEnd hooks failed");
  } catch (error) {
    if (strict) throw error;
  }
  if (adapter)
    try {
      const result = await adapter.events.emit(
        "conversation_close",
        {
          agentId,
          conversationId,
          durationMs,
          messageCount: telemetry.getMessageCount(),
          reason,
          toolCallCount: telemetry.getToolCallCount(),
        },
        adapter.context,
      );
      if (
        strict &&
        result.diagnostics.some((item) => item.severity !== "warning")
      )
        throw new Error("Source conversation_close hook failed");
    } catch (error) {
      if (strict) throw error;
    }
}
