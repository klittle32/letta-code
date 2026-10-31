/** Exact-turn interruption coordination; hosts retain execution ownership. */
export interface InterruptTurnRef {
  readonly id: string;
  readonly agentId: string | null;
  readonly conversationId: string;
}

export type TurnSettlementResource = "owner" | "backend" | "tools" | "children";

export interface TurnInterruptError {
  readonly resource: TurnSettlementResource | "abort";
  readonly message: string;
}

export type TurnInterruptOutcome =
  | { readonly status: "settled"; readonly turn: InterruptTurnRef }
  | {
      readonly status: "incomplete";
      readonly turn: InterruptTurnRef;
      readonly pending: readonly TurnSettlementResource[];
      readonly errors: readonly TurnInterruptError[];
    };

export interface TurnInterruptReceipt {
  readonly status: "requested";
  readonly turn: InterruptTurnRef;
  /** Host-observable settlement, never the UI's responsive abort-grace completion.
   * Does not certify termination of upstream provider compute or billing.
   */
  readonly completion: Promise<TurnInterruptOutcome>;
  /** A deadline observes incomplete work; it does not stop tracking that work. */
  wait(timeoutMs: number): Promise<TurnInterruptOutcome>;
}

export type TurnInterruptRequestResult =
  | TurnInterruptReceipt
  | {
      readonly status: "not-applied";
      readonly reason: "stale-turn" | "inactive-owner";
    };

export interface TurnInterruptController {
  request(
    ownerSignal: AbortSignal,
    reason?: string,
  ): TurnInterruptRequestResult;
}

const RESOURCES: readonly TurnSettlementResource[] = [
  "owner",
  "backend",
  "tools",
  "children",
];

/**
 * One coordinator per host-owned turn. Every callback must close over this exact
 * turn's resources, never look up a replacement turn or cancel a conversation.
 * Omitted settlement callbacks mean the host has no such resource. Unobservable
 * resources must instead be explicitly listed as unavailable.
 *
 * Requesting is synchronous, so awaited hooks can request cancellation without
 * waiting on their own completion. Await receipt completion outside the turn's
 * callback stack. A disposed owner cannot initiate or retarget an interrupt.
 */
export function createTurnInterruptController(options: {
  turn: InterruptTurnRef;
  isCurrent: () => boolean;
  abort: (reason?: string) => void;
  settlement: Partial<Record<TurnSettlementResource, () => Promise<void>>>;
  unavailable?: readonly TurnSettlementResource[];
}): TurnInterruptController {
  const turn = Object.freeze({ ...options.turn });
  const settlement = { ...options.settlement };
  const unavailable = new Set(options.unavailable ?? []);
  let receipt: TurnInterruptReceipt | undefined;

  return {
    request(ownerSignal, reason) {
      if (ownerSignal.aborted) {
        return { status: "not-applied", reason: "inactive-owner" };
      }
      if (!options.isCurrent()) {
        return { status: "not-applied", reason: "stale-turn" };
      }
      if (receipt) return receipt;

      const pending = new Set<TurnSettlementResource>(unavailable);
      const errors = new Map<TurnSettlementResource | "abort", string>();
      const tasks = RESOURCES.flatMap((resource) => {
        const task = settlement[resource];
        if (!task) return [];
        pending.add(resource);
        return [{ resource, task }];
      });
      const snapshot = (): TurnInterruptOutcome => {
        if (pending.size === 0 && errors.size === 0) {
          return { status: "settled", turn };
        }
        const errorOrder = ["abort", ...RESOURCES] as const;
        return {
          status: "incomplete",
          turn,
          pending: RESOURCES.filter((resource) => pending.has(resource)),
          errors: errorOrder.flatMap((resource) => {
            const message = errors.get(resource);
            return message === undefined ? [] : [{ resource, message }];
          }),
        };
      };
      let finish!: (outcome: TurnInterruptOutcome) => void;
      const completion = new Promise<TurnInterruptOutcome>((resolve) => {
        finish = resolve;
      });
      // Publish before abort: synchronous abort listeners may request again.
      receipt = {
        status: "requested",
        turn,
        completion,
        async wait(timeoutMs) {
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error(
              "Interrupt wait timeout must be positive finite milliseconds",
            );
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              completion,
              new Promise<TurnInterruptOutcome>((resolve) => {
                timer = setTimeout(() => resolve(snapshot()), timeoutMs);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        },
      };
      try {
        options.abort(reason);
      } catch (error) {
        errors.set(
          "abort",
          error instanceof Error ? error.message : String(error),
        );
      }
      // Every branch is observed even if another fails. Nothing widens an exact
      // backend cancellation into a conversation-wide fallback.
      void Promise.all(
        tasks.map(async ({ resource, task }) => {
          try {
            await task();
          } catch (error) {
            errors.set(
              resource,
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            if (!unavailable.has(resource)) pending.delete(resource);
          }
        }),
      ).then(() => finish(snapshot()));
      return receipt;
    },
  };
}
