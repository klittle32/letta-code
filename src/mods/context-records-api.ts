import type {
  ContextInboxInput,
  ContextInboxRecord,
  ContextSubmission,
} from "@/agent/context-inbox";

/** Host-local records only. list() is deliberately separate from getHistory().
 * Model visibility means delivery on the next explicit human submission.
 * Human/both transcript projection is unsupported and rejected explicitly.
 * Never record credentials, system prompts, memory, policy or skill bodies.
 */
export interface ModContextRecords {
  record(input: ContextInboxInput): Promise<ContextInboxRecord>;
  list(): Promise<ContextInboxRecord[]>;
  submissions(): Promise<ContextSubmission[]>;
  /** Positive chronological evidence only; otherwise remains uncertain. */
  reconcile(submissionId: string): Promise<ContextSubmission | null>;
}
