export interface ApprovalExecutionSnapshot {
  toolCallId: string;
  state: "queued" | "running" | "settled";
  executed: boolean;
  error?: unknown;
}

/** Internal per-owner tracking; synthetic interrupt results never settle a ticket. */
export class ApprovalExecutionSettlement {
  #cancelled = false;
  #entries: ApprovalExecutionSnapshot[] = [];
  #pending = new Set<Promise<void>>();

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** Fence future starts. The caller must also abort its execution signal. */
  cancel(): void {
    this.#cancelled = true;
  }

  snapshot(): ApprovalExecutionSnapshot[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  pendingToolCallIds(): string[] {
    return this.#entries
      .filter((entry) => entry.state !== "settled")
      .map((entry) => entry.toolCallId);
  }

  /** Wait for actual registered work, including checkpoints, not the abort race.
   * Call cancel first to fence future starts. This is not a promise about work
   * registered after this owner has become quiescent. Resolves even when a
   * ticket failed: callers must inspect snapshot entries' errors for checkpoint/fence
   * failures rather than interpreting settlement as successful persistence.
   */
  async waitForSettlement(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending);
  }

  register(toolCallId: string): ApprovalExecutionTicket {
    const entry: ApprovalExecutionSnapshot = {
      toolCallId,
      state: "queued",
      executed: false,
    };
    this.#entries.push(entry);
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.#pending.add(promise);
    return {
      start: () => {
        if (this.#cancelled || entry.state !== "queued") return false;
        entry.state = "running";
        entry.executed = true;
        return true;
      },
      finish: (error?: unknown) => {
        if (entry.state === "settled") return;
        entry.state = "settled";
        if (error !== undefined) entry.error = error;
        this.#pending.delete(promise);
        resolve();
      },
    };
  }
}

export interface ApprovalExecutionTicket {
  start(): boolean;
  finish(error?: unknown): void;
}
