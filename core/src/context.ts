// SPDX-License-Identifier: MIT
// Portions ported from llama.vscode (https://github.com/ggml-org/llama.vscode),
// MIT License, Copyright (c) 2025 The llama.vscode contributors.
// See ATTRIBUTIONS.md for details.
import type { ContextChunk, DocumentSnapshot, EngineConfig } from "./types.js";

/** Constants carried over from llama.vscode's tuned values. */
export const MAX_LAST_PICK_LINE_DISTANCE = 32;
export const MAX_QUEUED_CHUNKS = 16;
export const RING_UPDATE_MIN_TIME_LAST_COMPL_MS = 3000;

export function getPrefixLines(snapshot: DocumentSnapshot, nPrefix: number): string[] {
  const startLine = Math.max(0, snapshot.cursorLine - nPrefix);
  return snapshot.lines.slice(startLine, snapshot.cursorLine);
}

export function getSuffixLines(snapshot: DocumentSnapshot, nSuffix: number): string[] {
  const endLine = Math.min(snapshot.lines.length - 1, snapshot.cursorLine + nSuffix);
  return snapshot.lines.slice(snapshot.cursorLine + 1, endLine + 1);
}

function isOnlySpacesOrTabs(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

export interface LocalContext {
  inputPrefix: string;
  inputSuffix: string;
  prompt: string;
  linePrefix: string;
  lineSuffix: string;
  nIndent: number;
  /** Leading whitespace to strip from returned completions when the prompt was blanked. */
  spacesToRemove: number;
}

/**
 * Build the FIM context around the cursor (ported from llama.vscode
 * completion.ts getCompletionItems, local-context section).
 */
export function buildLocalContext(snapshot: DocumentSnapshot, config: EngineConfig): LocalContext {
  const prefixLines = getPrefixLines(snapshot, config.nPrefix);
  const suffixLines = getSuffixLines(snapshot, config.nSuffix);
  const lineText = snapshot.lines[snapshot.cursorLine] ?? "";
  const linePrefix = lineText.slice(0, snapshot.cursorChar);
  const lineSuffix = lineText.slice(snapshot.cursorChar);
  const nIndent = lineText.length - lineText.trimStart().length;

  let prompt = linePrefix;
  let spacesToRemove = 0;
  if (isOnlySpacesOrTabs(prompt)) {
    prompt = "";
    spacesToRemove = linePrefix.length;
  }

  return {
    inputPrefix: prefixLines.join("\n") + "\n",
    inputSuffix: lineSuffix + "\n" + suffixLines.join("\n") + "\n",
    prompt,
    linePrefix,
    lineSuffix,
    nIndent,
    spacesToRemove,
  };
}

/**
 * Jaccard similarity between two chunks of text, by line set
 * (ported from llama.vscode extra-context.ts).
 */
export function jaccardSimilarity(lines0: string[], lines1: string[]): number {
  if (lines0.length === 0 && lines1.length === 0) return 1;
  const setA = new Set(lines0);
  const setB = new Set(lines1);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

export interface RingConfig {
  nChunks: number;
  chunkSize: number;
  scope: number;
  nPrefix: number;
  nSuffix: number;
  updateMinTimeMs?: number;
  maxQueuedChunks?: number;
}

/**
 * Ring buffer of nearby-code chunks used as extra completion context
 * (ported from llama.vscode extra-context.ts, minus all IDE wiring — adapters
 * feed it from editor events; the engine drains it).
 */
export class ContextRing {
  readonly chunks: ContextChunk[] = [];
  private readonly chunksLines: string[][] = [];
  private readonly queuedChunks: ContextChunk[] = [];
  private readonly queuedChunksLines: string[][] = [];
  private lastCompletionStartTime = 0;
  private lastLinePick = -9999;
  private readonly config: RingConfig;
  private readonly rng: () => number;

  constructor(config: RingConfig, rng: () => number = Math.random) {
    this.config = config;
    this.rng = rng;
  }

  markCompletionStart(now: number = Date.now()): void {
    this.lastCompletionStartTime = now;
  }

  /**
   * Add a candidate chunk to the queue, evicting near-duplicates
   * (Jaccard similarity > 0.9) when `evictSimilar` is set.
   */
  pickChunk(
    lines: string[],
    fileName: string,
    evictSimilar: boolean,
    now: number = Date.now(),
  ): void {
    if (this.config.nChunks <= 0) return;
    // don't pick very small chunks
    if (lines.length < 3) return;

    let newChunkLines: string[];
    if (lines.length + 1 < this.config.chunkSize) {
      newChunkLines = lines;
    } else {
      const startLine = Math.floor(
        this.rng() * Math.max(0, lines.length - this.config.chunkSize / 2 + 1),
      );
      const endLine = Math.min(startLine + this.config.chunkSize / 2, lines.length);
      newChunkLines = lines.slice(startLine, endLine);
    }
    const chunkText = newChunkLines.join("\n") + "\n";

    if (
      evictSimilar &&
      (this.chunks.some((chunk) => chunk.text === chunkText) ||
        this.queuedChunks.some((chunk) => chunk.text === chunkText))
    ) {
      return;
    }

    if (evictSimilar) {
      for (let i = this.chunks.length - 1; i >= 0; i--) {
        if (jaccardSimilarity(this.chunksLines[i] ?? [], newChunkLines) > 0.9) {
          this.chunks.splice(i, 1);
          this.chunksLines.splice(i, 1);
        }
      }
      for (let i = this.queuedChunks.length - 1; i >= 0; i--) {
        if (jaccardSimilarity(this.queuedChunksLines[i] ?? [], newChunkLines) > 0.9) {
          this.queuedChunks.splice(i, 1);
          this.queuedChunksLines.splice(i, 1);
        }
      }
    }

    const maxQueued = this.config.maxQueuedChunks ?? MAX_QUEUED_CHUNKS;
    if (this.queuedChunks.length >= maxQueued) {
      this.queuedChunks.splice(0, 1);
      this.queuedChunksLines.splice(0, 1);
    }

    this.queuedChunks.push({ text: chunkText, time: now, filename: fileName });
    this.queuedChunksLines.push(newChunkLines);
  }

  /** Pick a chunk of lines centered on the cursor (used on editor switch / save). */
  pickChunkAroundCursor(snapshot: DocumentSnapshot, now: number = Date.now()): void {
    const half = this.config.chunkSize / 2;
    const start = Math.max(0, snapshot.cursorLine - half);
    const end = Math.min(snapshot.cursorLine + half, snapshot.lines.length - 1);
    this.pickChunk(snapshot.lines.slice(start, end + 1), snapshot.fileName, true, now);
  }

  /**
   * After a completion, gather far-prefix and far-suffix chunks — but only when
   * the cursor moved far since the last pick (ported from llama.vscode
   * extra-context.ts addFimContextChunks).
   */
  pickChunksAfterCompletion(snapshot: DocumentSnapshot, now: number = Date.now()): void {
    const deltaLines = Math.abs(snapshot.cursorLine - this.lastLinePick);
    if (deltaLines <= MAX_LAST_PICK_LINE_DISTANCE) return;

    const prefixStart = Math.max(0, snapshot.cursorLine - this.config.scope);
    const prefixEnd = Math.max(0, snapshot.cursorLine - this.config.nPrefix);
    this.pickChunk(snapshot.lines.slice(prefixStart, prefixEnd + 1), snapshot.fileName, false, now);

    const lastLine = snapshot.lines.length - 1;
    const suffixStart = Math.min(lastLine, snapshot.cursorLine + this.config.nSuffix);
    const suffixEnd = Math.min(
      lastLine,
      snapshot.cursorLine + this.config.nSuffix + this.config.chunkSize,
    );
    this.pickChunk(snapshot.lines.slice(suffixStart, suffixEnd + 1), snapshot.fileName, false, now);

    this.lastLinePick = snapshot.cursorLine;
  }

  /**
   * Move one queued chunk into the active ring (evicting the oldest beyond
   * capacity). Returns the current chunks when the ring changed — the caller
   * uses that to warm the backend cache — or undefined when idle. Skips while a
   * completion ran recently, so drains never compete with typing.
   */
  drainOne(now: number = Date.now()): ContextChunk[] | undefined {
    const minTime = this.config.updateMinTimeMs ?? RING_UPDATE_MIN_TIME_LAST_COMPL_MS;
    if (this.queuedChunks.length === 0 || now - this.lastCompletionStartTime < minTime) {
      return undefined;
    }
    const lines = this.queuedChunksLines.shift();
    const chunk = this.queuedChunks.shift();
    if (lines === undefined || chunk === undefined) return undefined;
    this.chunksLines.push(lines);
    this.chunks.push(chunk);
    while (this.chunks.length > this.config.nChunks) {
      this.chunks.shift();
      this.chunksLines.shift();
    }
    return [...this.chunks];
  }

  queuedCount(): number {
    return this.queuedChunks.length;
  }
}
