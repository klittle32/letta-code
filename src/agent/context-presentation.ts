import { createHash } from "node:crypto";
import type { Backend } from "@/backend/backend";
import type {
  ContextInboxScope,
  ContextPlacement,
  HumanContextEntry,
} from "./context-inbox";
export type HumanPresentationEntry = HumanContextEntry & { id: string };
export function contextNamespace(scope: ContextInboxScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}
type Scope = { agentId: string; conversationId: string };
/** One active in-process TUI observer; invalidations contain no record content. */
export function createContextPresentation() {
  let active:
    | {
        scope: Scope;
        backend: Backend;
        namespace?: string;
        boundary: () => ContextPlacement | undefined;
        notify: () => void;
      }
    | undefined;
  return {
    subscribe(
      scope: Scope,
      backend: Backend,
      boundary: () => ContextPlacement | undefined,
      notify: () => void,
    ) {
      const owner = {
        scope: { ...scope },
        backend,
        boundary,
        notify,
        namespace: undefined as string | undefined,
      };
      active = owner;
      return () => {
        if (active === owner) active = undefined;
      };
    },
    authorize(scope: ContextInboxScope, backend: Backend) {
      if (
        active?.backend === backend &&
        active.scope.agentId === scope.agent &&
        active.scope.conversationId === scope.conversation
      )
        active.namespace = contextNamespace(scope);
    },
    boundary(scope: ContextInboxScope, backend: Backend) {
      if (
        active?.backend === backend &&
        active.namespace === contextNamespace(scope)
      )
        return structuredClone(active.boundary());
      return undefined;
    },
    invalidate(scope: ContextInboxScope, backend: Backend) {
      if (
        active?.backend === backend &&
        active.scope.agentId === scope.agent &&
        active.scope.conversationId === scope.conversation
      )
        active.notify();
    },
  };
}
