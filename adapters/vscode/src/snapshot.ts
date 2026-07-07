// SPDX-License-Identifier: MIT
import type { DocumentSnapshot } from "@flashcomplete/core";
import * as vscode from "vscode";

export function toSnapshot(
  document: vscode.TextDocument,
  position: vscode.Position,
): DocumentSnapshot {
  return {
    lines: document.getText().split(/\r?\n/),
    cursorLine: position.line,
    cursorChar: position.character,
    fileName: document.fileName,
  };
}
