// SPDX-License-Identifier: MIT
// Portions ported from llama.vscode (https://github.com/ggml-org/llama.vscode),
// MIT License, Copyright (c) 2025 The llama.vscode contributors.
// See ATTRIBUTIONS.md for details.
import type { CompletionBackend } from "./backend.js";
import { CompletionCache } from "./cache.js";
import { buildLocalContext, ContextRing, type LocalContext } from "./context.js";
import { classifyFetchError, CompletionError } from "./errors.js";
import {
  removeLeadingWhitespace,
  removeTrailingNewLines,
  shouldDiscardSuggestion,
  updateSuggestion,
} from "./postprocess.js";
import type { CompletionRequest, EngineConfig, NormalizedTimings, StatusEvent } from "./types.js";

export type EngineOutcome =
  | {
      status: "suggested";
      suggestions: string[];
      fromCache: boolean;
      timings?: NormalizedTimings;
      /** Speculative prefetch + context gathering; tests await it, adapters ignore it. */
      background?: Promise<void>;
    }
  | { status: "empty"; background?: Promise<void> }
  | { status: "skipped"; reason: "cancelled" | "line-suffix" }
  | { status: "error"; error: CompletionError };

export interface EngineDeps {
  backend: CompletionBackend;
  cache: CompletionCache;
  ring: ContextRing;
  config: EngineConfig;
  onStatus?: (event: StatusEvent) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedup(contents: string[]): string[] {
  return Array.from(new Set(contents));
}

/**
 * The completion pipeline: debounce → cancel-previous → cache → backend →
 * post-process → cache write → speculative prefetch. Ported from llama.vscode's
 * completion.ts with two deliberate redesigns (docs/ARCHITECTURE-REVIEW.md):
 * a new request aborts the in-flight one instead of polling a busy flag, and
 * the cache key includes the backend/server identity.
 */
export class CompletionEngine {
  private readonly backend: CompletionBackend;
  private readonly cache: CompletionCache;
  private readonly ring: ContextRing;
  private readonly config: EngineConfig;
  private readonly onStatus?: (event: StatusEvent) => void;
  private inflight: AbortController | undefined;
  private prefetchInflight: AbortController | undefined;

  constructor(deps: EngineDeps) {
    this.backend = deps.backend;
    this.cache = deps.cache;
    this.ring = deps.ring;
    this.config = deps.config;
    this.onStatus = deps.onStatus;
  }

  get contextRing(): ContextRing {
    return this.ring;
  }

  private identity(): string {
    return this.backend.id + "|" + this.backend.identity();
  }

  async complete(request: CompletionRequest, externalSignal?: AbortSignal): Promise<EngineOutcome> {
    // Cancel whatever is still running — the newest keystroke always wins.
    this.inflight?.abort();
    this.prefetchInflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    const signal = controller.signal;
    if (externalSignal) {
      if (externalSignal.aborted) return { status: "skipped", reason: "cancelled" };
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    if (request.trigger === "auto" && this.config.debounceMs > 0) {
      await delay(this.config.debounceMs);
      if (signal.aborted) return { status: "skipped", reason: "cancelled" };
    }

    this.ring.markCompletionStart();
    const local = buildLocalContext(request.snapshot, this.config);

    if (request.trigger === "auto" && local.lineSuffix.length > this.config.maxLineSuffix) {
      return { status: "skipped", reason: "line-suffix" };
    }

    const identity = this.identity();
    let completions = request.bypassCache
      ? undefined
      : this.cache.getWithPrefixReuse(identity, local.inputPrefix, local.inputSuffix, local.prompt);
    const fromCache = completions !== undefined;
    let timings: NormalizedTimings | undefined;

    if (completions === undefined) {
      if (signal.aborted) return { status: "skipped", reason: "cancelled" };
      this.onStatus?.({ state: "thinking" });
      try {
        const result = await this.backend.complete(
          {
            inputPrefix: local.inputPrefix,
            inputSuffix: local.inputSuffix,
            prompt: local.prompt,
            chunks: this.ring.chunks,
            nIndent: local.nIndent > 0 ? local.nIndent : undefined,
          },
          signal,
        );
        completions = dedup(result.contents);
        timings = result.timings;
      } catch (err) {
        const error = classifyFetchError(err);
        if (error.kind === "aborted") return { status: "skipped", reason: "cancelled" };
        this.onStatus?.({ state: "error", message: error.message });
        return { status: "error", error };
      }
    }

    if (completions === undefined || completions.length === 0) {
      this.onStatus?.({ state: "empty" });
      return { status: "empty" };
    }

    const accepted: string[] = [];
    let firstAcceptedLines: string[] = [];
    for (const completion of completions) {
      const suggestionLines = completion.split(/\r?\n/);
      removeTrailingNewLines(suggestionLines);
      if (
        shouldDiscardSuggestion(
          suggestionLines,
          request.snapshot,
          local.linePrefix,
          local.lineSuffix,
        )
      ) {
        continue;
      }
      accepted.push(updateSuggestion(suggestionLines, local.lineSuffix));
      if (firstAcceptedLines.length === 0) firstAcceptedLines = suggestionLines;
    }

    if (accepted.length === 0) {
      this.onStatus?.({ state: "empty" });
      return { status: "empty" };
    }

    if (!fromCache) {
      this.cache.put(identity, local.inputPrefix, local.inputSuffix, local.prompt, accepted);
    }

    this.onStatus?.({ state: fromCache ? "cached" : "done", timings });

    const background = this.runBackground(request, local, firstAcceptedLines, signal);

    return {
      status: "suggested",
      suggestions: accepted.map((text) => removeLeadingWhitespace(text, local.spacesToRemove)),
      fromCache,
      timings,
      background,
    };
  }

  /**
   * Drain one queued context chunk into the ring and warm the backend's
   * server-side cache when it supports that. Adapters call this on a timer.
   */
  warmTick(now: number = Date.now()): void {
    const chunks = this.ring.drainOne(now);
    if (chunks && this.backend.capabilities().kvWarmup && this.backend.warmContext) {
      this.backend.warmContext(chunks);
    }
  }

  private async runBackground(
    request: CompletionRequest,
    local: LocalContext,
    firstAcceptedLines: string[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (!signal.aborted && local.lineSuffix.trim() === "") {
        const prefetchController = new AbortController();
        this.prefetchInflight = prefetchController;
        await this.prefetchAfterFullAccept(local, firstAcceptedLines, prefetchController.signal);
        this.prefetchAfterLineAccept(local, firstAcceptedLines);
      }
      if (!signal.aborted) {
        this.ring.pickChunksAfterCompletion(request.snapshot);
      }
    } catch {
      // Speculative work must never surface errors to the editor.
    }
  }

  /**
   * Pre-request the completion the user will need right after accepting the
   * whole suggestion (ported from llama.vscode completion.ts cacheFutureSuggestion).
   */
  private async prefetchAfterFullAccept(
    local: LocalContext,
    suggestionLines: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const firstLine = suggestionLines[0] ?? "";
    let futureInputPrefix = local.inputPrefix;
    const futureInputSuffix = local.inputSuffix;
    let futurePrompt = local.prompt + firstLine;
    if (suggestionLines.length > 1) {
      futureInputPrefix =
        local.inputPrefix + local.prompt + suggestionLines.slice(0, -1).join("\n") + "\n";
      futurePrompt = suggestionLines[suggestionLines.length - 1] ?? "";
      const futureInputPrefixLines = futureInputPrefix.slice(0, -1).split(/\r?\n/);
      if (futureInputPrefixLines.length > this.config.nPrefix) {
        futureInputPrefix =
          futureInputPrefixLines
            .slice(futureInputPrefixLines.length - this.config.nPrefix)
            .join("\n") + "\n";
      }
    }

    const identity = this.identity();
    if (
      this.cache.get(identity, futureInputPrefix, futureInputSuffix, futurePrompt) !== undefined
    ) {
      return;
    }
    const result = await this.backend.complete(
      {
        inputPrefix: futureInputPrefix,
        inputSuffix: futureInputSuffix,
        prompt: futurePrompt,
        chunks: this.ring.chunks,
        nIndent: local.prompt.length - local.prompt.trimStart().length || undefined,
      },
      signal,
    );
    const contents = dedup(result.contents).filter((content) => content.trim() !== "");
    if (contents.length === 0) return;
    const futureSuggestions = contents.map((content) => {
      const lines = content.split(/\r?\n/);
      removeTrailingNewLines(lines);
      return lines.join("\n");
    });
    this.cache.put(identity, futureInputPrefix, futureInputSuffix, futurePrompt, futureSuggestions);
  }

  /**
   * Seed the cache with the state the user reaches by accepting only the first
   * line — pure cache math, no server call (ported from llama.vscode
   * completion.ts cacheFutureAcceptLineSuggestion).
   */
  private prefetchAfterLineAccept(local: LocalContext, suggestionLines: string[]): void {
    if (suggestionLines.length <= 1) return;
    const futureInputPrefix = local.inputPrefix + local.prompt + (suggestionLines[0] ?? "") + "\n";
    const futureInputSuffix = local.inputSuffix;
    const futurePrompt = "";
    const identity = this.identity();
    if (
      this.cache.get(identity, futureInputPrefix, futureInputSuffix, futurePrompt) !== undefined
    ) {
      return;
    }
    this.cache.put(identity, futureInputPrefix, futureInputSuffix, futurePrompt, [
      suggestionLines.slice(1).join("\n"),
    ]);
  }
}
