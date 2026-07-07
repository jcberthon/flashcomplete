// SPDX-License-Identifier: MIT
import {
  CompletionCache,
  CompletionEngine,
  type CompletionError,
  ContextRing,
  LlamaCppInfillBackend,
} from "@flashcomplete/core";
import * as vscode from "vscode";
import { registerCommands } from "./commands.js";
import { registerContextFeeds } from "./context-feeds.js";
import { FlashCompleteProvider, type Session } from "./provider.js";
import { readSettings, type Settings } from "./settings.js";
import { StatusBar } from "./statusbar.js";

function createSession(statusbar: StatusBar): Session {
  const settings: Settings = readSettings();
  const backend = new LlamaCppInfillBackend({
    endpoint: settings.endpoint,
    apiKey: settings.apiKey || undefined,
    nPredict: settings.nPredict,
    tMaxPromptMs: settings.tMaxPromptMs,
    tMaxPredictMs: settings.tMaxPredictMs,
    requestTimeoutMs: settings.requestTimeoutMs,
  });
  const engine = new CompletionEngine({
    backend,
    cache: new CompletionCache(settings.maxCacheKeys),
    ring: new ContextRing({
      nChunks: settings.ringNChunks,
      chunkSize: settings.ringChunkSize,
      scope: settings.ringScope,
      nPrefix: settings.nPrefix,
      nSuffix: settings.nSuffix,
    }),
    config: {
      debounceMs: settings.debounceMs,
      nPrefix: settings.nPrefix,
      nSuffix: settings.nSuffix,
      maxLineSuffix: settings.maxLineSuffix,
    },
    onStatus: statusbar.onStatus,
  });
  statusbar.setEnabled(settings.enabled);
  return { engine, settings };
}

export function activate(context: vscode.ExtensionContext): void {
  const statusbar = new StatusBar();
  context.subscriptions.push(statusbar);

  let session = createSession(statusbar);
  const getSession = (): Session => session;

  // Settings changes rebuild the whole session (engine, cache, ring, backend).
  // That intentionally drops the completion cache: a changed endpoint or model
  // must never serve completions produced by the previous one.
  let warnedConfigError = false;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("flashcomplete")) {
        session = createSession(statusbar);
        warnedConfigError = false;
      }
    }),
  );

  const onError = (error: CompletionError): void => {
    // Transient failures stay in the statusbar (rendered via onStatus); only a
    // configuration problem deserves an actionable, one-time message.
    if (error.kind === "config" && !warnedConfigError) {
      warnedConfigError = true;
      void vscode.window
        .showWarningMessage(`FlashComplete: ${error.message}. ${error.hint ?? ""}`, "Open Settings")
        .then((choice) => {
          if (choice === "Open Settings") {
            void vscode.commands.executeCommand("workbench.action.openSettings", "flashcomplete");
          }
        });
    }
  };

  const provider = new FlashCompleteProvider(getSession, onError);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
  );

  registerCommands(context, provider);
  registerContextFeeds(context, getSession);
}

export function deactivate(): void {}
