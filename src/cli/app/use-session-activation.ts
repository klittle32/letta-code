import { useCallback, useRef, useState } from "react";
import { getBackend } from "@/backend";
import { resolveChdirTarget } from "@/cli/helpers/chdir-command";
import type { ModQuestionHandler } from "@/mods/question-api";
import type { ModSessionActivationHandler } from "@/mods/session-api";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import {
  commitRuntimeWorkingDirectory,
  loadSettingsForWorkingDirectory,
  switchCurrentRuntimeWorkingDirectory,
} from "@/runtime-working-directory";
import { settingsManager } from "@/settings-manager";
import {
  initializeNewTuiConversation,
  installNewTuiConversation,
} from "./new-conversation";
import type { createTuiCommandLock } from "./tui-command-lock";
import { createTuiSessionActivation } from "./tui-session-activation";
import { getTuiSessionActivationBlocker } from "./tui-session-admission";
import { assertTuiActivationDirectoryAllowed } from "./tui-session-policy";
import { validateFreshTuiConversation } from "./tui-session-target";
import type { SubmitHandlerContext } from "./use-submit-handler";

export function useSessionActivationBridge() {
  const handler = useRef<ModSessionActivationHandler | undefined>(undefined);
  const onActivate = useCallback<ModSessionActivationHandler>(
    (request) =>
      handler.current?.(request) ??
      Promise.resolve({
        status: "refused",
        reason: "Session activation is not ready",
      }),
    [],
  );
  return { handler, onActivate };
}
export function useTuiSessionActivation(
  context: SubmitHandlerContext,
  options: {
    ask: ModQuestionHandler;
    lock: ReturnType<typeof createTuiCommandLock>;
    processing: { current: number };
    blockedUi: boolean;
    pendingApprovalResults: () => unknown[] | null;
    report: (error: unknown) => void;
  },
): ModSessionActivationHandler {
  const latest = useRef({ context, options });
  latest.current = { context, options };
  const [activate] = useState(() =>
    createTuiSessionActivation({
      scope: () => {
        const { context: ctx } = latest.current;
        return {
          agentId: ctx.agentIdRef.current,
          conversationId: ctx.conversationIdRef.current,
          workingDirectory: getCurrentWorkingDirectory(),
          generation: ctx.conversationGenerationRef.current,
          backend: getBackend(),
        };
      },
      blocked: (request) => {
        const { context: ctx, options: opts } = latest.current;
        return getTuiSessionActivationBlocker(request, {
          blockedUi: opts.blockedUi,
          commandBlocked: opts.lock.commandBlocks(request.invocationSignal),
          processing: opts.processing.current,
          executing: ctx.isExecutingTool,
          approvals: ctx.pendingApprovals.length,
          results: opts.pendingApprovalResults()?.length ?? 0,
          queued: ctx.tuiQueueRef.current?.length ?? 0,
          turnRef: ctx.abortControllerRef,
        });
      },
      setLocked: (value) =>
        latest.current.options.lock.setActivation(value, {
          agentId: latest.current.context.agentIdRef.current,
          conversationId: latest.current.context.conversationIdRef.current,
        }),
      resolve: resolveChdirTarget,
      validateTarget: (request) =>
        validateFreshTuiConversation(
          getBackend(),
          request.agentId ?? "",
          request.conversationId,
        ),
      guard: (path, source) =>
        assertTuiActivationDirectoryAllowed(
          path,
          source,
          getRuntimeContext()?.workspaceSandbox,
        ),
      ask: async (request, path) => {
        const question = `Allow ${request.owner.path} to activate fresh conversation ${request.conversationId} in ${path}? Source: ${request.sourceConversationId}. This trusts destination project settings and lifecycle hooks.`;
        const result = await latest.current.options.ask({
          agentId: request.agentId,
          conversationId: request.sourceConversationId,
          owner: request.owner,
          signal: request.signal,
          questions: [
            {
              header: "Activate",
              question,
              options: [
                {
                  label: "Allow",
                  description:
                    "Trust this destination and activate the exact fresh conversation.",
                },
                {
                  label: "Deny",
                  description: "Keep the current conversation and directory.",
                },
              ],
            },
          ],
        });
        return (
          result.status === "answered" && result.answers[question] === "Allow"
        );
      },
      endSource: () => latest.current.context.runEndHooks("new", true),
      prepare: loadSettingsForWorkingDirectory,
      restore: async (source) => {
        await switchCurrentRuntimeWorkingDirectory(source.workingDirectory);
        settingsManager.persistSession(
          source.agentId,
          source.conversationId,
          source.workingDirectory,
        );
      },
      commit: (request, path) => {
        const ctx = latest.current.context;
        commitRuntimeWorkingDirectory(path);
        settingsManager.persistSession(
          request.agentId ?? "",
          request.conversationId,
          path,
        );
        ctx.conversationGenerationRef.current++;
        ctx.resetPendingReasoningCycle();
        ctx.setConversationAutoTitleEligibility(false);
        installNewTuiConversation(ctx, request.conversationId);
        ctx.sharedReminderStateRef.current.hasSentSessionContext = false;
        ctx.sharedReminderStateRef.current.pendingSessionContextReason =
          "cwd_changed";
      },
      initialize: async (request, path, source, signal) => {
        const ctx = latest.current.context;
        // Invalidate source owners only after commit; never await this from activate().
        await ctx.modAdapter.reload(signal);
        signal.throwIfAborted();
        const errors = ctx.modAdapter.engine
          .getSnapshot()
          .diagnostics.filter(
            (diagnostic) => diagnostic.severity !== "warning",
          );
        if (errors.length)
          throw new Error(
            errors.map((diagnostic) => diagnostic.error.message).join("; "),
          );
        await initializeNewTuiConversation(
          ctx,
          request.conversationId,
          source.conversationId,
          path,
          true,
        );
      },
      report: (error) => latest.current.options.report(error),
    }),
  );
  return activate;
}
