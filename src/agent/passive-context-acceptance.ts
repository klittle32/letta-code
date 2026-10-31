import type { ContextSubmission } from "./context-inbox";

interface CanonicalInputIdentity {
  message_type?: unknown;
  id?: unknown;
  otid?: unknown;
}

/** Positive evidence only: no missing/terminal/error event proves rejection.
 * The caller must supply canonical rows from the original bound request stream,
 * or chronological history read through the original captured backend/account
 * and conversation. Never combine unrelated/resumed streams as acceptance proof.
 * This helper neither persists a receipt nor changes inbox uncertainty.
 */
export function createPassiveContextAcceptance(binding: ContextSubmission) {
  const humanOtid = binding.id;
  const contextOtid = binding.contextMessageOtid;
  const needsContext = binding.records.length > 0;
  if (!humanOtid || !contextOtid || humanOtid === contextOtid) {
    throw new Error(
      "Distinct context and human submission identities are required",
    );
  }
  let contextId: string | undefined;
  let humanSeen = false;
  let accepted = false;
  return Object.freeze({
    get accepted() {
      return accepted;
    },
    /** True only on the first observation establishing acceptance. */
    observe(row: CanonicalInputIdentity): boolean {
      if (
        accepted ||
        row.message_type !== "user_message" ||
        typeof row.id !== "string" ||
        !row.id.trim()
      )
        return false;
      if (row.otid === contextOtid && !humanSeen) {
        contextId ??= row.id;
      }
      if (row.otid !== humanOtid || humanSeen) return false;
      humanSeen = true;
      accepted =
        !needsContext || (contextId !== undefined && contextId !== row.id);
      return accepted;
    },
  });
}
