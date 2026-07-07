// SPDX-License-Identifier: MIT

/**
 * Error taxonomy for completion failures. Backends map transport failures into
 * these kinds; adapters decide the UX per kind (statusbar vs actionable message)
 * without ever inspecting backend-specific error shapes.
 */
export type CompletionErrorKind =
  /** Missing or invalid user configuration (e.g. no endpoint set). */
  | "config"
  /** Could not reach the server (connection refused, DNS, socket errors). */
  | "network"
  /** The client-side request timeout elapsed. */
  | "timeout"
  /** The request was cancelled (superseded or editor moved on). */
  | "aborted"
  /** The server answered with an HTTP error status. */
  | "http"
  | "unknown";

export class CompletionError extends Error {
  readonly kind: CompletionErrorKind;
  /** HTTP status code, when kind is "http". */
  readonly status?: number;
  /** Short actionable hint for the user, when one exists. */
  readonly hint?: string;

  constructor(
    kind: CompletionErrorKind,
    message: string,
    options?: { status?: number; hint?: string; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "CompletionError";
    this.kind = kind;
    this.status = options?.status;
    this.hint = options?.hint;
  }
}

/** Classify a failure thrown by fetch() into the taxonomy above. */
export function classifyFetchError(err: unknown): CompletionError {
  if (err instanceof CompletionError) return err;
  // fetch aborts throw DOMException, which is not `instanceof Error` in Node —
  // classify by name, not by prototype chain.
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (name === "AbortError") {
    return new CompletionError("aborted", "Request was cancelled", { cause: err });
  }
  if (name === "TimeoutError") {
    return new CompletionError("timeout", "Request timed out", { cause: err });
  }
  if (err instanceof Error) {
    const causeCode = (err.cause as { code?: string } | undefined)?.code;
    if (causeCode === "ECONNREFUSED" || causeCode === "ENOTFOUND" || causeCode === "ECONNRESET") {
      return new CompletionError("network", `Cannot reach the completion server (${causeCode})`, {
        hint: "Is the server running? Check the endpoint setting.",
        cause: err,
      });
    }
    return new CompletionError("unknown", err.message, { cause: err });
  }
  return new CompletionError("unknown", String(err));
}
