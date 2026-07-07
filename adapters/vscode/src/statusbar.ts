// SPDX-License-Identifier: MIT
import type { StatusEvent } from "@flashcomplete/core";
import * as vscode from "vscode";

/**
 * Renders engine status. Consumes only core's normalized events and timings —
 * never a backend's raw response fields (AGENTS.md).
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private enabled = true;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = "FlashComplete";
    this.item.command = "flashcomplete.toggle";
    this.showIdle();
    this.item.show();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.showIdle();
  }

  onStatus = (event: StatusEvent): void => {
    if (!this.enabled) return;
    switch (event.state) {
      case "thinking":
        this.item.text = "$(loading~spin) flash";
        this.item.tooltip = "FlashComplete: requesting completion…";
        break;
      case "done": {
        const parts: string[] = [];
        if (event.timings?.predictMs !== undefined) {
          parts.push(`${Math.round(event.timings.predictMs)}ms`);
        }
        if (event.timings?.tokensPerSecond !== undefined) {
          parts.push(`${Math.round(event.timings.tokensPerSecond)} t/s`);
        }
        this.item.text = `$(zap) ${parts.join(" · ") || "flash"}`;
        this.item.tooltip = this.timingsTooltip(event);
        break;
      }
      case "cached":
        this.item.text = "$(zap) cached";
        this.item.tooltip = "FlashComplete: served from the local completion cache";
        break;
      case "empty":
        this.showIdle();
        break;
      case "error":
        this.item.text = "$(warning) flash";
        this.item.tooltip = `FlashComplete: ${event.message ?? "completion failed"}`;
        break;
    }
  };

  private timingsTooltip(event: StatusEvent): string {
    const timings = event.timings;
    if (!timings) return "FlashComplete";
    const lines = ["FlashComplete"];
    if (timings.promptMs !== undefined || timings.promptTokens !== undefined) {
      lines.push(
        `prompt: ${timings.promptTokens ?? "?"} tokens in ${Math.round(timings.promptMs ?? 0)}ms`,
      );
    }
    if (timings.predictMs !== undefined || timings.predictedTokens !== undefined) {
      lines.push(
        `predict: ${timings.predictedTokens ?? "?"} tokens in ${Math.round(timings.predictMs ?? 0)}ms`,
      );
    }
    if (timings.cachedTokens !== undefined) {
      lines.push(`server cache: ${timings.cachedTokens} tokens`);
    }
    return lines.join("\n");
  }

  private showIdle(): void {
    if (this.enabled) {
      this.item.text = "$(zap) flash";
      this.item.tooltip = "FlashComplete: ready (click to disable)";
    } else {
      this.item.text = "$(circle-slash) flash";
      this.item.tooltip = "FlashComplete: disabled (click to enable)";
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
