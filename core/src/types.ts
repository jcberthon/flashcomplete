// SPDX-License-Identifier: MIT

/**
 * Plain-data snapshot of the document around the cursor. Adapters build this
 * from their IDE's document type; core never sees IDE objects (AGENTS.md).
 */
export interface DocumentSnapshot {
  /** All document lines, without line terminators. */
  lines: string[];
  /** Zero-based cursor line. */
  cursorLine: number;
  /** Zero-based cursor column (character offset within the line). */
  cursorChar: number;
  /** File name used to label context chunks. */
  fileName: string;
}

/** A chunk of nearby code kept in the context ring buffer. */
export interface ContextChunk {
  text: string;
  time: number;
  filename: string;
}

export type CompletionTrigger = "auto" | "manual";

export interface CompletionRequest {
  snapshot: DocumentSnapshot;
  trigger: CompletionTrigger;
  /** Skip the completion cache and force a fresh backend request. */
  bypassCache?: boolean;
}

/** What a backend can do; the engine selects behavior from this, never from the backend's type. */
export interface BackendCapabilities {
  fim: boolean;
  chatFallback: boolean;
  streaming: boolean;
  /** Accepts extra context chunks with the request (e.g. llama.cpp `input_extra`). */
  contextInjection: boolean;
  /** Supports warmContext() to pre-warm server-side caches. */
  kvWarmup: boolean;
}

/** Backend-neutral timing info; adapters must display this, never raw backend fields. */
export interface NormalizedTimings {
  promptMs?: number;
  predictMs?: number;
  promptTokens?: number;
  predictedTokens?: number;
  tokensPerSecond?: number;
  cachedTokens?: number;
}

/** The context handed to a backend for one completion request. */
export interface CompletionContext {
  inputPrefix: string;
  inputSuffix: string;
  prompt: string;
  chunks: ContextChunk[];
  nIndent?: number;
}

/** What a backend returns: one or more raw completion candidates plus timings. */
export interface BackendResult {
  contents: string[];
  timings?: NormalizedTimings;
}

/** Engine tuning knobs; carried over from llama.vscode's proven defaults. */
export interface EngineConfig {
  debounceMs: number;
  nPrefix: number;
  nSuffix: number;
  maxLineSuffix: number;
}

export interface StatusEvent {
  state: "thinking" | "done" | "cached" | "empty" | "error";
  timings?: NormalizedTimings;
  message?: string;
}
