// SPDX-License-Identifier: MIT
// Portions ported from llama.vscode (https://github.com/ggml-org/llama.vscode),
// MIT License, Copyright (c) 2025 The llama.vscode contributors.
// See ATTRIBUTIONS.md for details.
import type { DocumentSnapshot } from "./types.js";

export function removeTrailingNewLines(suggestionLines: string[]): void {
  while (suggestionLines.length > 0 && (suggestionLines.at(-1) ?? "").trim() === "") {
    suggestionLines.pop();
  }
}

export function getLeadingWhitespace(input: string): string {
  const match = /^[ \t]*/.exec(input);
  return match ? match[0] : "";
}

/** Strip up to `n` leading whitespace characters (spaces or tabs). */
export function removeLeadingWhitespace(text: string, n: number): string {
  let i = 0;
  while (i < text.length && i < n && (text[i] === " " || text[i] === "\t")) {
    i++;
  }
  return text.slice(i);
}

/**
 * Heuristics for discarding suggestions that merely repeat text already in the
 * document (ported from llama.vscode completion.ts shouldDiscardSuggestion).
 */
export function shouldDiscardSuggestion(
  suggestionLines: string[],
  snapshot: DocumentSnapshot,
  linePrefix: string,
  lineSuffix: string,
): boolean {
  const lineCount = snapshot.lines.length;
  const cursorLine = snapshot.cursorLine;
  const lineAt = (i: number): string => snapshot.lines[i] ?? "";

  if (suggestionLines.length === 0) return true;
  const firstLine = suggestionLines[0] ?? "";

  // discard an all-whitespace one-line suggestion
  if (suggestionLines.length === 1 && firstLine.trim() === "") return true;

  // if cursor is on the last line, don't discard
  if (cursorLine === lineCount - 1) return false;

  // ... and the next lines are repeated
  if (
    suggestionLines.length > 1 &&
    (firstLine.trim() === "" || firstLine.trim() === lineSuffix.trim()) &&
    suggestionLines.slice(1).every((value, index) => value === lineAt(cursorLine + 1 + index))
  ) {
    return true;
  }

  // discard if the suggestion just repeats the suffix
  if (suggestionLines.length === 1 && firstLine === lineSuffix) return true;

  // find the first non-empty line after the cursor
  let firstNonEmptyDocLine = cursorLine + 1;
  while (firstNonEmptyDocLine < lineCount && lineAt(firstNonEmptyDocLine).trim() === "") {
    firstNonEmptyDocLine++;
  }

  // if all lines to the end of file are empty, don't discard
  if (firstNonEmptyDocLine >= lineCount) return false;

  if (linePrefix + firstLine === lineAt(firstNonEmptyDocLine)) {
    // discard if the suggestion repeats the next non-empty line
    if (suggestionLines.length === 1) return true;

    // ... or if the second suggestion line is a prefix of the line after it
    const secondLine = suggestionLines[1] ?? "";
    if (
      suggestionLines.length === 2 &&
      secondLine === lineAt(firstNonEmptyDocLine + 1).slice(0, secondLine.length)
    ) {
      return true;
    }

    // ... or if the rest of the suggestion matches the following document lines
    if (
      suggestionLines.length > 2 &&
      suggestionLines
        .slice(1)
        .every((value, index) => value === lineAt(firstNonEmptyDocLine + 1 + index))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Trim the suggestion when the cursor has a non-empty line suffix
 * (ported from llama.vscode completion.ts updateSuggestion).
 */
export function updateSuggestion(suggestionLines: string[], lineSuffix: string): string {
  const firstLine = suggestionLines[0] ?? "";
  if (lineSuffix.trim() !== "") {
    if (firstLine.endsWith(lineSuffix)) return firstLine.slice(0, -lineSuffix.length);
    if (suggestionLines.length > 1) return firstLine;
  }
  return suggestionLines.join("\n");
}
