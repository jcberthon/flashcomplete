// SPDX-License-Identifier: MIT
import * as vscode from "vscode";
import type { Session } from "./provider.js";
import { toSnapshot } from "./snapshot.js";

/**
 * Feeds the context ring buffer from editor events and drains it on a timer
 * (which also warms the backend's server-side cache when supported). Mirrors
 * llama.vscode's wiring in architect.ts/extra-context.ts, minus the clipboard
 * interception (deferred — docs/FUTURE_WORK.md).
 */
export function registerContextFeeds(
  context: vscode.ExtensionContext,
  getSession: () => Session,
): void {
  let saveTimeout: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const { engine, settings } = getSession();
      if (!settings.enabled) return;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
          engine.contextRing.pickChunkAroundCursor(toSnapshot(document, editor.selection.active));
        } else {
          const snapshot = toSnapshot(document, new vscode.Position(0, 0));
          engine.contextRing.pickChunk(snapshot.lines, snapshot.fileName, true);
        }
      }, 1000);
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const { engine, settings } = getSession();
      if (!settings.enabled || !editor) return;
      if (EXCLUDED_SCHEMES.has(editor.document.uri.scheme)) return;
      engine.contextRing.pickChunkAroundCursor(
        toSnapshot(editor.document, editor.selection.active),
      );
    }),

    new vscode.Disposable(() => {
      if (saveTimeout) clearTimeout(saveTimeout);
    }),
  );

  // Drain the ring / warm the server on a steady tick. The interval length is a
  // session setting, so the timer re-reads it lazily instead of being rebuilt.
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    const { engine, settings } = getSession();
    if (settings.enabled) engine.warmTick();
    timer = setTimeout(schedule, Math.max(250, getSession().settings.ringUpdateMs));
  };
  schedule();
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (timer) clearTimeout(timer);
    }),
  );
}

const EXCLUDED_SCHEMES = new Set(["output", "debug", "search-editor", "comment"]);
