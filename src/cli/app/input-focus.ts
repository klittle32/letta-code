import {
  cancelActiveConnectOperation,
  isActiveConnectOperationCancellable,
} from "@/cli/commands/connect-command-state";
import type { PendingModQuestion } from "@/cli/mods/question-queue";

/** Host prompts share one keyboard owner; security and selectors always win. */
export function getQuestionFocus(options: {
  pending: PendingModQuestion | null;
  reflectionPending: boolean;
  showExitStats: boolean;
  streaming: boolean;
  commandRunning: boolean;
  isExecutingTool: boolean;
  pendingApprovals: unknown[];
  anySelectorOpen: boolean;
}) {
  const available =
    !options.showExitStats &&
    options.pendingApprovals.length === 0 &&
    !options.anySelectorOpen;
  const reflectionArenaChoiceVisible =
    available &&
    options.reflectionPending &&
    !options.streaming &&
    !options.commandRunning &&
    !options.isExecutingTool;
  const modQuestion =
    available && !reflectionArenaChoiceVisible ? options.pending : null;
  return {
    reflectionArenaChoiceVisible,
    modQuestion,
    inputEnabled: available && !reflectionArenaChoiceVisible && !modQuestion,
  };
}

export function onEscapeCommandCancel(): boolean {
  if (!isActiveConnectOperationCancellable()) return false;
  cancelActiveConnectOperation();
  return true;
}
