// SPDX-License-Identifier: MIT
export const CORE_VERSION = "0.9.0";

export type { CompletionBackend } from "./backend.js";
export { LlamaCppInfillBackend } from "./backends/llamacpp.js";
export type { LlamaCppConfig } from "./backends/llamacpp.js";
export { CompletionCache, LRUCache, sha256 } from "./cache.js";
export {
  buildLocalContext,
  ContextRing,
  getPrefixLines,
  getSuffixLines,
  jaccardSimilarity,
  MAX_LAST_PICK_LINE_DISTANCE,
  MAX_QUEUED_CHUNKS,
  RING_UPDATE_MIN_TIME_LAST_COMPL_MS,
} from "./context.js";
export type { LocalContext, RingConfig } from "./context.js";
export { CompletionEngine } from "./engine.js";
export type { EngineDeps, EngineOutcome } from "./engine.js";
export { classifyFetchError, CompletionError } from "./errors.js";
export type { CompletionErrorKind } from "./errors.js";
export {
  getLeadingWhitespace,
  removeLeadingWhitespace,
  removeTrailingNewLines,
  shouldDiscardSuggestion,
  updateSuggestion,
} from "./postprocess.js";
export type {
  BackendCapabilities,
  BackendResult,
  CompletionContext,
  CompletionRequest,
  CompletionTrigger,
  ContextChunk,
  DocumentSnapshot,
  EngineConfig,
  NormalizedTimings,
  StatusEvent,
} from "./types.js";
