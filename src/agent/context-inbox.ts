import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import { renameSyncWithRetry } from "@/utils/rename-sync-with-retry";

/** Explicit host namespace; backend/account are stable identities, never credentials. */
export interface ContextInboxScope {
  backend: string;
  account: string;
  agent: string;
  conversation: string;
}
export type ContextVisibility = "human" | "model" | "both";
export interface ContextInboxInput {
  id: string;
  text: string;
  visibility: ContextVisibility;
}
/** This is a host record, not a Cloud transcript message or server acceptance. */
export interface ContextInboxRecord extends ContextInboxInput {
  storage: "host-local";
  sequence: number;
}
export type ContextPlacement = {
  after: { otid?: string; messageId?: string; toolCallId?: string } | null;
};
export type HumanContextEntry = {
  record: ContextInboxRecord;
  placement: ContextPlacement | null;
};
export type ContextSubmissionOutcome =
  | "prepared"
  | "uncertain"
  | "accepted"
  | "rejected";
export interface ContextSubmission {
  id: string;
  outcome: ContextSubmissionOutcome;
  contextMessageOtid: string;
  requestFingerprint: string | null;
  records: ContextInboxRecord[];
}
interface StoredSubmission {
  id: string;
  outcome: ContextSubmissionOutcome;
  contextMessageOtid: string;
  requestFingerprint: string | null;
  recordIds: string[];
}
interface InboxState {
  scope: ContextInboxScope;
  records: ContextInboxRecord[];
  submissions: StoredSubmission[];
  placements?: { id: string; placement: ContextPlacement }[];
}
export interface ContextInbox {
  record(
    input: ContextInboxInput,
    placement?: ContextPlacement,
  ): Promise<ContextInboxRecord>;
  humanEntries(): Promise<HumanContextEntry[]>;
  /** All host records for this audience, including already accepted records.
   * Delivery selection belongs exclusively to bindExplicitSubmission.
   */
  list(audience?: "human" | "model"): Promise<ContextInboxRecord[]>;
  /** Caller supplies a stable explicit-user submission identity (e.g. its OTID).
   * Repeating this call returns the original frozen selection, never new items.
   * Optional SHA-256 request fingerprint is fixed at first binding; subsequent
   * composition must match it. The context-message UUID is also persisted once.
   * Does not dispatch anything. Approval/automated inputs must not call this.
   */
  bindExplicitSubmission(
    id: string,
    requestFingerprint?: string,
  ): Promise<ContextSubmission>;
  getSubmission(id: string): Promise<ContextSubmission | null>;
  /** Recovery inspection only; uncertain entries must never be blindly replayed. */
  listSubmissions(): Promise<ContextSubmission[]>;
  /** Persist BEFORE dispatch. A crash after this point requires reconciliation,
   * not automatic release/replay. Repeat dispatch only with the same request IDs.
   */
  markDispatch(id: string): Promise<ContextSubmission>;
  /** Host-only positive admission rejection proof. Preserve the exact immutable
   * request/selection for a safe retry; never call for generic errors/abort. */
  confirmNotAdmitted(id: string): Promise<ContextSubmission>;
  /** Acceptance means request acceptance, not successful turn completion.
   * Rejection must establish non-acceptance (or cancellation BEFORE dispatch).
   * A timeout, abort after dispatch, or failed turn is insufficient evidence.
   */
  settleSubmission(
    id: string,
    outcome: Exclude<ContextSubmissionOutcome, "prepared">,
  ): Promise<ContextSubmission>;
}

export class ContextSubmissionIdentityError extends Error {
  readonly code = "submission-identity-conflict";
  constructor() {
    super(
      "Submission ID already bound to different input; use the original request or a new submission ID",
    );
  }
}

function requireIdentity(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Context inbox identity must be nonempty");
  return value.trim();
}

/** Trims identities only: callers must supply canonical backend/account names.
 * No case folding or URL rewriting that could merge distinct backend namespaces.
 */
export function normalizeContextInboxScope(
  scope: ContextInboxScope,
): ContextInboxScope {
  return {
    backend: requireIdentity(scope.backend),
    account: requireIdentity(scope.account),
    agent: requireIdentity(scope.agent),
    conversation: requireIdentity(scope.conversation),
  };
}

function validVisibility(value: unknown): value is ContextVisibility {
  return value === "human" || value === "model" || value === "both";
}
function validOutcome(value: unknown): value is ContextSubmissionOutcome {
  return (
    value === "prepared" ||
    value === "uncertain" ||
    value === "accepted" ||
    value === "rejected"
  );
}
function validId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function validPlacement(value: unknown): value is ContextPlacement {
  if (!value || typeof value !== "object" || !("after" in value)) return false;
  const after = value.after;
  return (
    after === null ||
    (typeof after === "object" &&
      (("otid" in after && validId(after.otid)) ||
        ("messageId" in after && validId(after.messageId)) ||
        ("toolCallId" in after && validId(after.toolCallId))) &&
      (!("otid" in after) || validId(after.otid)) &&
      (!("messageId" in after) || validId(after.messageId)) &&
      (!("toolCallId" in after) || validId(after.toolCallId)))
  );
}

function validateState(
  value: unknown,
  scope: ContextInboxScope,
): asserts value is InboxState {
  const fail = () => {
    throw new Error("Corrupt context inbox; refusing to overwrite");
  };
  if (!value || typeof value !== "object") return fail();
  const state = value as InboxState;
  if (
    JSON.stringify(state.scope) !== JSON.stringify(scope) ||
    !Array.isArray(state.records) ||
    !Array.isArray(state.submissions)
  )
    return fail();
  const ids = new Set<string>();
  for (const [index, record] of state.records.entries()) {
    if (
      !record ||
      !validId(record.id) ||
      typeof record.text !== "string" ||
      !validVisibility(record.visibility) ||
      record.storage !== "host-local" ||
      record.sequence !== index + 1 ||
      ids.has(record.id)
    )
      return fail();
    ids.add(record.id);
  }
  if (state.placements !== undefined) {
    if (!Array.isArray(state.placements)) return fail();
    const placed = new Set<string>();
    for (const item of state.placements) {
      if (
        !item ||
        !ids.has(item.id) ||
        placed.has(item.id) ||
        !validPlacement(item.placement)
      )
        return fail();
      if (state.records.find((r) => r.id === item.id)?.visibility === "model")
        return fail();
      placed.add(item.id);
    }
  }
  const submissions = new Set<string>();
  const reserved = new Set<string>();
  const contextOtids = new Set<string>();
  for (const submission of state.submissions) {
    if (
      !submission ||
      !validId(submission.id) ||
      submissions.has(submission.id) ||
      !validOutcome(submission.outcome) ||
      typeof submission.contextMessageOtid !== "string" ||
      !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
        submission.contextMessageOtid,
      ) ||
      contextOtids.has(submission.contextMessageOtid) ||
      !(
        submission.requestFingerprint === null ||
        (typeof submission.requestFingerprint === "string" &&
          /^[\da-f]{64}$/.test(submission.requestFingerprint))
      ) ||
      !Array.isArray(submission.recordIds)
    )
      return fail();
    submissions.add(submission.id);
    contextOtids.add(submission.contextMessageOtid);
    let previousSequence = 0;
    for (const id of submission.recordIds) {
      const record = state.records.find((item) => item.id === id);
      if (
        !record ||
        record.visibility === "human" ||
        record.sequence <= previousSequence
      )
        return fail();
      previousSequence = record.sequence;
      if (submission.outcome !== "rejected") {
        if (reserved.has(id)) return fail();
        reserved.add(id);
      }
    }
  }
}

/** Read-only host classification metadata. Validate the entire atomic snapshot and
 * its namespace filename; never return collaborator text or authorize delivery. */
export async function readContextInboxMetadata(
  directory: string,
  filename: string,
) {
  if (!/^[a-f0-9]{64}\.json$/.test(filename))
    throw new Error("Invalid inbox filename");
  const value = JSON.parse(
    await readFile(join(directory, filename), "utf8"),
  ) as InboxState;
  const scope = normalizeContextInboxScope(value.scope);
  const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  if (filename !== `${key}.json`)
    throw new Error("Context inbox namespace mismatch");
  validateState(value, scope);
  const reserved = new Set(
    value.submissions
      .filter((s) => s.outcome === "accepted" || s.outcome === "uncertain")
      .flatMap((s) => s.recordIds),
  );
  return {
    scope,
    contextOtids: value.submissions
      .filter((s) => s.recordIds.length > 0)
      .map((s) => s.contextMessageOtid),
    submissionIds: value.submissions.map((s) => s.id),
    hasHuman: value.records.some((r) => r.visibility !== "model"),
    hasPending: value.records.some(
      (r) => r.visibility !== "human" && !reserved.has(r.id),
    ),
  };
}

/** Scoped immutable records in one atomic host-local snapshot. No inference,
 * transport, retries, server IDs, or claim of exactly-once server delivery.
 * Atomic replacement covers process crashes; directory metadata is not fsynced,
 * so this does not promise durability through power loss. No retention/GC is
 * performed: IDs remain available for idempotency.
 * Directory is caller-owned; no ambient user-state path is read or written.
 */
export function createContextInbox(options: {
  directory: string;
  scope: ContextInboxScope;
}): ContextInbox {
  if (!isAbsolute(options.directory))
    throw new Error("Context inbox directory must be absolute");
  const directory = resolve(options.directory);
  const scope = normalizeContextInboxScope(options.scope);
  const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const path = join(directory, `${key}.json`);

  async function access<T>(
    operation: (state: InboxState) => { result: T; changed?: boolean },
  ): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileLock(
      `${path}.lock`,
      async () => {
        let state: InboxState;
        try {
          const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
          validateState(parsed, scope);
          state = parsed;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          state = { scope, records: [], submissions: [] };
        }
        const { result, changed } = operation(state);
        if (changed) {
          const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(state));
            await file.sync();
            await file.close();
            renameSyncWithRetry(temporary, path);
          } finally {
            await file.close().catch(() => undefined);
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        }
        // No mutable state escapes into caller-owned objects.
        return structuredClone(result);
      },
      { reapOnlyDeadOwner: true },
    );
  }
  function projection(
    state: InboxState,
    submission: StoredSubmission,
  ): ContextSubmission {
    return {
      id: submission.id,
      outcome: submission.outcome,
      contextMessageOtid: submission.contextMessageOtid,
      requestFingerprint: submission.requestFingerprint,
      records: submission.recordIds.map((id) => {
        const record = state.records.find((item) => item.id === id);
        if (!record) throw new Error("Missing context record in submission");
        return record;
      }),
    };
  }
  function findSubmission(state: InboxState, id: string): StoredSubmission {
    const submission = state.submissions.find((item) => item.id === id);
    if (!submission) throw new Error(`Unknown context submission: ${id}`);
    return submission;
  }
  return {
    record(input, placement) {
      if (placement !== undefined && !validPlacement(placement))
        throw new Error("Invalid context placement");
      const capturedPlacement =
        placement === undefined ? undefined : structuredClone(placement);
      const id = requireIdentity(input.id);
      if (
        id !== input.id ||
        typeof input.text !== "string" ||
        !validVisibility(input.visibility)
      )
        throw new Error("Invalid context record");
      // Capture input before waiting on the lock.
      const captured = { id, text: input.text, visibility: input.visibility };
      return access((state) => {
        const existing = state.records.find((record) => record.id === id);
        if (existing) {
          if (
            existing.text !== captured.text ||
            existing.visibility !== captured.visibility
          )
            throw new Error(`Context record ID conflict: ${id}`);
          return { result: existing };
        }
        const record: ContextInboxRecord = {
          ...captured,
          storage: "host-local",
          sequence: state.records.length + 1,
        };
        state.records.push(record);
        if (record.visibility !== "model" && capturedPlacement !== undefined) {
          state.placements ??= [];
          state.placements.push({ id, placement: capturedPlacement });
        }
        return { result: record, changed: true };
      });
    },
    humanEntries() {
      return access((state) => ({
        result: state.records
          .filter((r) => r.visibility !== "model")
          .map((record) => ({
            record,
            placement:
              state.placements?.find((p) => p.id === record.id)?.placement ??
              null,
          })),
      }));
    },
    list(audience) {
      if (
        audience !== undefined &&
        audience !== "human" &&
        audience !== "model"
      )
        throw new Error("Invalid context audience");
      return access((state) => ({
        result: state.records.filter(
          (record) =>
            !audience ||
            record.visibility === audience ||
            record.visibility === "both",
        ),
      }));
    },
    bindExplicitSubmission(rawId, requestFingerprint) {
      const id = requireIdentity(rawId);
      if (
        requestFingerprint !== undefined &&
        !/^[\da-f]{64}$/.test(requestFingerprint)
      )
        throw new Error("Invalid request fingerprint");
      return access((state) => {
        const existing = state.submissions.find((item) => item.id === id);
        if (existing) {
          if (
            requestFingerprint !== undefined &&
            existing.requestFingerprint !== requestFingerprint
          )
            throw new ContextSubmissionIdentityError();
          return { result: projection(state, existing) };
        }
        const reserved = new Set(
          state.submissions
            .filter((item) => item.outcome !== "rejected")
            .flatMap((item) => item.recordIds),
        );
        const submission: StoredSubmission = {
          id,
          outcome: "prepared",
          contextMessageOtid: randomUUID(),
          requestFingerprint: requestFingerprint ?? null,
          recordIds: state.records
            .filter(
              (record) =>
                record.visibility !== "human" && !reserved.has(record.id),
            )
            .map((record) => record.id),
        };
        state.submissions.push(submission);
        return { result: projection(state, submission), changed: true };
      });
    },
    getSubmission(rawId) {
      const id = requireIdentity(rawId);
      return access((state) => {
        const submission = state.submissions.find((item) => item.id === id);
        return { result: submission ? projection(state, submission) : null };
      });
    },
    listSubmissions() {
      return access((state) => ({
        result: state.submissions.map((item) => projection(state, item)),
      }));
    },
    markDispatch(rawId) {
      const id = requireIdentity(rawId);
      return access((state) => {
        const submission = findSubmission(state, id);
        if (
          submission.outcome === "accepted" ||
          submission.outcome === "rejected"
        )
          throw new Error("Context submission is already settled");
        const changed = submission.outcome !== "uncertain";
        submission.outcome = "uncertain";
        return { result: projection(state, submission), changed };
      });
    },
    confirmNotAdmitted(rawId) {
      const id = requireIdentity(rawId);
      return access((state) => {
        const submission = findSubmission(state, id);
        if (submission.outcome !== "uncertain")
          throw new Error(
            "Only a dispatched request can be proven not admitted",
          );
        submission.outcome = "prepared";
        return { result: projection(state, submission), changed: true };
      });
    },
    settleSubmission(rawId, outcome) {
      const id = requireIdentity(rawId);
      if (
        outcome !== "uncertain" &&
        outcome !== "accepted" &&
        outcome !== "rejected"
      )
        throw new Error("Invalid settlement");
      return access((state) => {
        const submission = findSubmission(state, id);
        if (submission.outcome === outcome)
          return { result: projection(state, submission) };
        if (
          submission.outcome === "accepted" ||
          submission.outcome === "rejected"
        )
          throw new Error("Context submission is already settled");
        if (submission.outcome === "prepared" && outcome !== "rejected")
          throw new Error("Mark dispatch before settling a sent submission");
        submission.outcome = outcome;
        return { result: projection(state, submission), changed: true };
      });
    },
  };
}
