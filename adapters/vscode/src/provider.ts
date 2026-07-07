// SPDX-License-Identifier: MIT
import type { CompletionEngine, CompletionError } from "@flashcomplete/core";
import * as vscode from "vscode";
import type { Settings } from "./settings.js";
import { toSnapshot } from "./snapshot.js";

export interface Session {
  engine: CompletionEngine;
  settings: Settings;
}

/** Document schemes that should never receive completions. */
const EXCLUDED_SCHEMES = new Set(["output", "debug", "search-editor", "comment"]);

export class FlashCompleteProvider implements vscode.InlineCompletionItemProvider {
  private bypassNextRequest = false;

  constructor(
    private readonly getSession: () => Session,
    private readonly onError: (error: CompletionError) => void,
  ) {}

  /** The next request skips the completion cache (used by the no-cache trigger command). */
  forceNewRequest(): void {
    this.bypassNextRequest = true;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    const { engine, settings } = this.getSession();
    if (!settings.enabled) return null;
    if (EXCLUDED_SCHEMES.has(document.uri.scheme)) return null;
    const isAuto = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    if (isAuto && !settings.autoTrigger) return null;

    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    const bypassCache = this.bypassNextRequest;
    this.bypassNextRequest = false;

    try {
      const outcome = await engine.complete(
        {
          snapshot: toSnapshot(document, position),
          trigger: isAuto ? "auto" : "manual",
          bypassCache,
        },
        abort.signal,
      );

      if (outcome.status === "error") {
        this.onError(outcome.error);
        return null;
      }
      if (outcome.status !== "suggested") return null;

      return outcome.suggestions.map(
        (text) => new vscode.InlineCompletionItem(text, new vscode.Range(position, position)),
      );
    } finally {
      cancellation.dispose();
    }
  }
}
