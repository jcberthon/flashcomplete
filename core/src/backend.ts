// SPDX-License-Identifier: MIT
import type {
  BackendCapabilities,
  BackendResult,
  CompletionContext,
  ContextChunk,
} from "./types.js";

/**
 * The single seam between the engine and any model server (AGENTS.md contract).
 * A new backend is a new implementation of this interface under src/backends/;
 * it must require zero changes to the engine itself.
 */
export interface CompletionBackend {
  /** Stable backend identifier (e.g. "llamacpp"); part of the completion cache key. */
  readonly id: string;

  capabilities(): BackendCapabilities;

  /**
   * Identity of the concrete server/model this backend currently targets
   * (endpoint plus model when known). Part of the completion cache key so a
   * backend/model switch can never serve stale completions.
   */
  identity(): string;

  /**
   * Request one completion. Must respect `signal` (cancellation and client-side
   * timeout) and throw CompletionError on failure. Never interacts with UI.
   */
  complete(ctx: CompletionContext, signal: AbortSignal): Promise<BackendResult>;

  /** Optional server-side cache warm-up (e.g. llama.cpp KV cache). Fire-and-forget. */
  warmContext?(chunks: ContextChunk[]): void;
}
