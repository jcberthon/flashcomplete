// SPDX-License-Identifier: MIT
import * as vscode from "vscode";
import type { FlashCompleteProvider } from "./provider.js";

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: FlashCompleteProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("flashcomplete.triggerCompletion", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }),

    vscode.commands.registerCommand("flashcomplete.triggerNoCache", async () => {
      provider.forceNewRequest();
      await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }),

    // Partial accepts use VS Code's native inline-suggestion commands — one of
    // the lessons from the llama.vscode review, which re-implemented these with
    // manual edits and shadow state (docs/ARCHITECTURE-REVIEW.md §6).
    vscode.commands.registerCommand("flashcomplete.acceptFirstLine", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.acceptNextLine");
    }),

    vscode.commands.registerCommand("flashcomplete.acceptNextWord", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.acceptNextWord");
    }),

    vscode.commands.registerCommand("flashcomplete.toggle", async () => {
      const config = vscode.workspace.getConfiguration("flashcomplete");
      const enabled = config.get<boolean>("enabled", true);
      await config.update("enabled", !enabled, vscode.ConfigurationTarget.Global);
    }),
  );
}
