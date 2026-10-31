import { waitForModLoad } from "@/mods/mod-load-cancellation";
import type {
  ModSessionActivationHandler,
  ModSessionActivationRequest,
} from "@/mods/session-api";

export interface TuiActivationScope {
  agentId: string;
  conversationId: string;
  workingDirectory: string;
  generation: number;
  backend?: object;
}
export interface TuiSessionActivationDependencies {
  initializationTimeoutMs?: number;
  scope(): TuiActivationScope;
  blocked(request: ModSessionActivationRequest): string | undefined;
  setLocked(value: boolean): void;
  resolve(path: string, source: string): Promise<string>;
  validateTarget(request: ModSessionActivationRequest): Promise<void>;
  guard(path: string, source: TuiActivationScope): void;
  ask(request: ModSessionActivationRequest, path: string): Promise<boolean>;
  endSource(): Promise<void>;
  prepare(path: string): Promise<void>;
  restore(source: TuiActivationScope): Promise<void>;
  commit(request: ModSessionActivationRequest, path: string): void;
  initialize(
    request: ModSessionActivationRequest,
    path: string,
    source: TuiActivationScope,
    signal: AbortSignal,
  ): Promise<void>;
  report(error: unknown): void;
}
/** One TUI admission lock; commit is synchronous and initialization never self-awaits. */
export function createTuiSessionActivation(
  deps: TuiSessionActivationDependencies,
): ModSessionActivationHandler {
  let locked = false;
  return async (incoming) => {
    const request = { ...incoming, owner: { ...incoming.owner } };
    if (locked)
      return {
        status: "refused",
        reason: "Session activation already in progress",
      };
    const source = deps.scope();
    let prepared = false;
    let committed = false;
    const check = () => {
      const now = deps.scope();
      if (request.signal.aborted)
        throw new Error("Session activation cancelled");
      if (request.owner.scope !== "global")
        throw new Error("Only global mods may activate a session");
      if (
        request.agentId !== source.agentId ||
        request.sourceConversationId !== source.conversationId ||
        request.sourceWorkingDirectory !== source.workingDirectory ||
        now.agentId !== source.agentId ||
        now.conversationId !== source.conversationId ||
        now.workingDirectory !== source.workingDirectory ||
        now.generation !== source.generation ||
        now.backend !== source.backend
      )
        throw new Error("Source session changed");
      if (request.conversationId === source.conversationId)
        throw new Error("Destination must be a different fresh conversation");
      const blocked = deps.blocked(request);
      if (blocked) throw new Error(blocked);
    };
    try {
      check();
      locked = true;
      deps.setLocked(true);
      const destination = await deps.resolve(
        request.workingDirectory,
        source.workingDirectory,
      );
      check();
      deps.guard(destination, source);
      await deps.validateTarget(request);
      check();
      if (!(await deps.ask(request, destination)))
        throw new Error("Destination trust was not granted");
      check();
      const recheck = async () => {
        if (
          (await deps.resolve(
            request.workingDirectory,
            source.workingDirectory,
          )) !== destination
        )
          throw new Error("Destination changed");
        check();
        deps.guard(destination, source);
        await deps.validateTarget(request);
        check();
      };
      await recheck();
      prepared = true;
      await deps.prepare(destination);
      // Settings preparation may await; check all mutable admission state again.
      check();
      await recheck();
      await deps.endSource();
      check();
      deps.commit(request, destination);
      committed = true;
      // Do not await source mod teardown or destination lifecycle in its invocation.
      const initializationSignal = AbortSignal.timeout(
        deps.initializationTimeoutMs ?? 10_000,
      );
      void Promise.resolve()
        .then(() =>
          waitForModLoad(
            deps.initialize(request, destination, source, initializationSignal),
            initializationSignal,
          ),
        )
        .catch((error) =>
          deps.report(
            new Error(
              `Session initialization incomplete: ${initializationSignal.aborted ? "deadline expired" : error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            ),
          ),
        )
        .finally(() => {
          locked = false;
          deps.setLocked(false);
        });
      return {
        status: "activated",
        initialization: "pending",
        conversationId: request.conversationId,
        workingDirectory: destination,
      };
    } catch (error) {
      if (prepared && !committed) {
        try {
          const now = deps.scope();
          const originalScope =
            now.agentId === source.agentId &&
            now.conversationId === source.conversationId &&
            now.generation === source.generation;
          await deps.restore(originalScope ? source : now);
        } catch (restoreError) {
          deps.report(restoreError);
        }
      }
      return {
        status: "refused",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (!committed && locked) {
        locked = false;
        deps.setLocked(false);
      }
    }
  };
}
