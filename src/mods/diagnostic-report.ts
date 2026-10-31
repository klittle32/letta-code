import type {
  ModDiagnosticReportOptions,
  ModDiagnosticSeverity,
} from "./types";
export function normalizeReportedDiagnostic(
  diagnostic: ModDiagnosticReportOptions,
): { message: string; severity: ModDiagnosticSeverity } {
  if (!diagnostic || typeof diagnostic !== "object") {
    throw new Error("Mod diagnostic report must be an object");
  }
  if (typeof diagnostic.message !== "string") {
    throw new Error("Mod diagnostic report must include a message");
  }
  const message = diagnostic.message.trim();
  if (message.length === 0) {
    throw new Error("Mod diagnostic report message cannot be empty");
  }
  if (
    diagnostic.severity !== undefined &&
    diagnostic.severity !== "error" &&
    diagnostic.severity !== "warning"
  ) {
    throw new Error("Mod diagnostic severity must be 'error' or 'warning'");
  }
  return { message, severity: diagnostic.severity ?? "error" };
}
