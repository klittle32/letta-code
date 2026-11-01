import type {
  ContextInboxInput,
  ContextInboxRecord,
  ContextSubmission,
} from "@/agent/context-inbox";

/** Host-local records only. list() is deliberately separate from getHistory().
 * Model visibility means delivery on the next explicit human submission.
 * Human visibility inserts a durable, labelled host-local TUI row without model
 * delivery. Both displays that row once and also selects model delivery only on
 * the next explicit human submission. Positioning is at whole-message boundaries.
 * Never record credentials, system prompts, memory, policy or skill bodies.
 */
export interface ModContextRecords {
  record(input: ContextInboxInput): Promise<ContextInboxRecord>;
  list(): Promise<ContextInboxRecord[]>;
  submissions(): Promise<ContextSubmission[]>;
  /** Positive chronological evidence only; otherwise remains uncertain. */
  reconcile(submissionId: string): Promise<ContextSubmission | null>;
}
