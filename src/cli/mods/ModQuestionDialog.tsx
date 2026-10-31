import { Box } from "ink";
import type { AskUserQuestion } from "@/ask-user-question";
import { InlineQuestionApproval } from "@/cli/components/InlineQuestionApproval";
import type { PendingModQuestion } from "./question-queue";

export function ModQuestionDialog({
  pending,
}: {
  pending: PendingModQuestion | null;
}) {
  return pending ? (
    <InlineQuestionApproval
      key={pending.id}
      questions={pending.request.questions}
      onSubmit={pending.submit}
      onCancel={pending.dismiss}
    />
  ) : null;
}

/** The reflection choice and mod questions use the same native prompt surface. */
export function NativeQuestionPrompts({
  reflection,
  modQuestion,
  onSubmit,
  onCancel,
}: {
  reflection: { runId: string; questions: AskUserQuestion[] } | null;
  modQuestion: PendingModQuestion | null;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  return (
    <>
      {reflection ? (
        <Box marginTop={1} flexDirection="column">
          <InlineQuestionApproval
            key={reflection.runId}
            questions={reflection.questions}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        </Box>
      ) : (
        <ModQuestionDialog pending={modQuestion} />
      )}
    </>
  );
}
