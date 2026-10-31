import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { createModQuestionQueue } from "./question-queue";

export function useModQuestions(
  agentId: string | null,
  conversationId: string | null,
) {
  const [queue] = useState(() =>
    createModQuestionQueue(agentId, conversationId),
  );
  useLayoutEffect(() => {
    queue.setScope(agentId, conversationId);
  }, [queue, agentId, conversationId]);
  useEffect(() => () => queue.dispose(), [queue]);
  const pending = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  // Never paint the old scope even on the render preceding the layout cleanup.
  const scoped =
    pending?.request.agentId === agentId &&
    pending.request.conversationId === conversationId
      ? pending
      : null;
  return { ask: queue.ask, pending: scoped };
}
