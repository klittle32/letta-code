import type { MutableRefObject } from "react";
import {
  type ContextTracker,
  resetContextHistory,
} from "@/cli/helpers/context-tracker";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { runSessionStartHooks } from "@/hooks";
import { buildModInvocationContext } from "@/mods/context";

export interface NewTuiConversationContext {
  agentId: string;
  agentName: string | null;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  resetBootstrapReminderState: (pending?: boolean) => void;
  setConversationIdAndRef: (id: string) => void;
  sessionHooksRanRef: MutableRefObject<boolean>;
  sessionStartFeedbackRef: MutableRefObject<string[]>;
  modAdapter: LocalModAdapter;
}
export function installNewTuiConversation(
  ctx: NewTuiConversationContext,
  id: string,
): void {
  ctx.setConversationIdAndRef(id);
  ctx.pendingConversationSwitchRef.current = {
    origin: "new",
    conversationId: id,
    isDefault: false,
  };
  resetContextHistory(ctx.contextTrackerRef.current);
  ctx.resetBootstrapReminderState(true);
}
export async function startTuiSessionHooks(
  ctx: Pick<
    NewTuiConversationContext,
    "agentId" | "agentName" | "sessionStartFeedbackRef"
  >,
  isNew: boolean,
  id?: string,
  cwd = process.cwd(),
  strict = false,
): Promise<void> {
  const result = await runSessionStartHooks(
    isNew,
    ctx.agentId,
    ctx.agentName ?? undefined,
    id,
    cwd,
  );
  if (result.feedback.length)
    ctx.sessionStartFeedbackRef.current = result.feedback;
  if (strict && (result.errored || result.blocked))
    throw new Error("Destination SessionStart hooks failed");
}

/** Both /new and trusted activation use the same detached initialization body. */
export async function initializeNewTuiConversation(
  ctx: NewTuiConversationContext,
  id: string,
  previousId: string,
  workingDirectory = process.cwd(),
  strict = false,
): Promise<void> {
  ctx.sessionHooksRanRef.current = true;
  const results = await Promise.allSettled([
    startTuiSessionHooks(ctx, true, id, workingDirectory, strict),
    ctx.modAdapter.events
      .emit(
        "conversation_open",
        {
          agentId: ctx.agentId,
          agentName: ctx.agentName,
          conversationId: id,
          previousConversationId: previousId,
          reason: "new",
        },
        buildModInvocationContext({
          base: ctx.modAdapter.context,
          conversationId: id,
          workingDirectory,
        }),
      )
      .then((result) => {
        if (
          strict &&
          result.diagnostics.some((item) => item.severity !== "warning")
        )
          throw new Error("Destination conversation_open hook failed");
      }),
  ]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}
