// SPDX-License-Identifier: MIT
// Portions ported from llama.vscode (https://github.com/ggml-org/llama.vscode),
// MIT License, Copyright (c) 2025 The llama.vscode contributors.
// See ATTRIBUTIONS.md for details.
import { createHash } from "node:crypto";

/** Plain LRU keyed by string, ported from llama.vscode's lru-cache.ts. */
export class LRUCache {
  private readonly capacity: number;
  private readonly map = new Map<string, string[]>();

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error("Capacity must be greater than 0");
    }
    this.capacity = capacity;
  }

  get(key: string): string[] | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  put(key: string, value: string[]): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const leastRecentlyUsedKey = this.map.keys().next().value;
      if (leastRecentlyUsedKey !== undefined) {
        this.map.delete(leastRecentlyUsedKey);
      }
    }
  }

  size(): number {
    return this.map.size;
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Completion cache with the composite key llama.vscode lacked: the backend and
 * server/model identity are part of every key, so switching backends, endpoints
 * or models can never serve a stale completion (see docs/ARCHITECTURE-REVIEW.md,
 * Phase 3 refactoring #1).
 *
 * Also ports llama.vscode's prompt-prefix reuse: while the user types exactly
 * what a cached completion predicted, the cache keeps answering with the
 * remainder of that completion instead of hitting the backend again.
 */
export class CompletionCache {
  private readonly lru: LRUCache;

  constructor(capacity: number) {
    this.lru = new LRUCache(capacity);
  }

  private key(identity: string, inputPrefix: string, inputSuffix: string, prompt: string): string {
    return sha256(identity + "|" + inputPrefix + "|" + inputSuffix + "|" + prompt);
  }

  put(
    identity: string,
    inputPrefix: string,
    inputSuffix: string,
    prompt: string,
    completions: string[],
  ): void {
    this.lru.put(this.key(identity, inputPrefix, inputSuffix, prompt), completions);
  }

  /** Exact lookup only. */
  get(
    identity: string,
    inputPrefix: string,
    inputSuffix: string,
    prompt: string,
  ): string[] | undefined {
    return this.lru.get(this.key(identity, inputPrefix, inputSuffix, prompt));
  }

  /**
   * Exact lookup, then progressively shorter prompts whose cached completion
   * starts with what was typed since (ported from llama.vscode
   * completion.ts getCachedCompletion).
   */
  getWithPrefixReuse(
    identity: string,
    inputPrefix: string,
    inputSuffix: string,
    prompt: string,
  ): string[] | undefined {
    const exact = this.get(identity, inputPrefix, inputSuffix, prompt);
    if (exact !== undefined) return exact;

    for (let i = prompt.length; i >= 0; i--) {
      const shorterPrompt = prompt.slice(0, i);
      const typedSince = prompt.slice(i);
      const cached = this.get(identity, inputPrefix, inputSuffix, shorterPrompt);
      if (cached === undefined) continue;
      const completions: string[] = [];
      for (const completion of cached) {
        if (completion && typedSince === completion.slice(0, typedSince.length)) {
          completions.push(completion.slice(typedSince.length));
        }
      }
      if (completions.length > 0) return completions;
    }
    return undefined;
  }

  size(): number {
    return this.lru.size();
  }
}
