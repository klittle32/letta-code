import type { ModQuestionRequest } from "@/mods/question-api";
import type { ModAskResult } from "@/mods/types";

export interface PendingModQuestion {
  id: number;
  request: ModQuestionRequest;
  submit: (answers: Record<string, string>) => void;
  dismiss: () => void;
}

/** Local host queue: deliberately has no conversation delivery or inference surface. */
export function createModQuestionQueue(
  agentId: string | null,
  conversationId: string | null,
) {
  let nextId = 0;
  let disposed = false;
  let entries: Array<
    PendingModQuestion & { settle: (result: ModAskResult) => void }
  > = [];
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const cancelAll = (reason: "cancelled" | "scope-changed") => {
    for (const entry of [...entries])
      entry.settle({ status: "dismissed", reason });
  };
  return {
    ask(request: ModQuestionRequest): Promise<ModAskResult> {
      if (disposed || request.signal.aborted)
        return Promise.resolve({ status: "dismissed", reason: "cancelled" });
      if (
        request.agentId !== agentId ||
        request.conversationId !== conversationId
      ) {
        return Promise.resolve({
          status: "dismissed",
          reason: "scope-changed",
        });
      }
      return new Promise((resolve) => {
        let settled = false;
        const abort = () =>
          settle({ status: "dismissed", reason: "cancelled" });
        const settle = (result: ModAskResult) => {
          if (settled) return;
          settled = true;
          request.signal.removeEventListener("abort", abort);
          entries = entries.filter((entry) => entry !== pending);
          publish();
          resolve(result);
        };
        const pending = {
          id: ++nextId,
          request,
          settle,
          submit(answers: Record<string, string>) {
            if (
              !request.questions.every(
                (q) =>
                  typeof answers[q.question] === "string" &&
                  answers[q.question]?.trim(),
              )
            )
              return;
            settle({ status: "answered", answers: { ...answers } });
          },
          dismiss: () => settle({ status: "dismissed", reason: "cancelled" }),
        };
        entries.push(pending);
        request.signal.addEventListener("abort", abort, { once: true });
        publish();
      });
    },
    getSnapshot: (): PendingModQuestion | null => entries[0] ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setScope(nextAgentId: string | null, nextConversationId: string | null) {
      if (nextAgentId === agentId && nextConversationId === conversationId)
        return;
      agentId = nextAgentId;
      conversationId = nextConversationId;
      cancelAll("scope-changed");
    },
    dispose() {
      disposed = true;
      cancelAll("cancelled");
    },
  };
}
