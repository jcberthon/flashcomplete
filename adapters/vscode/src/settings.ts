// SPDX-License-Identifier: MIT
import * as vscode from "vscode";

export interface Settings {
  enabled: boolean;
  autoTrigger: boolean;
  endpoint: string;
  apiKey: string;
  debounceMs: number;
  requestTimeoutMs: number;
  nPrefix: number;
  nSuffix: number;
  nPredict: number;
  maxLineSuffix: number;
  maxCacheKeys: number;
  ringNChunks: number;
  ringChunkSize: number;
  ringScope: number;
  ringUpdateMs: number;
  tMaxPromptMs: number;
  tMaxPredictMs: number;
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration("flashcomplete");
  return {
    enabled: config.get<boolean>("enabled", true),
    autoTrigger: config.get<boolean>("autoTrigger", true),
    endpoint: config.get<string>("endpoint", "http://127.0.0.1:8012"),
    apiKey: config.get<string>("apiKey", ""),
    debounceMs: config.get<number>("debounceMs", 0),
    requestTimeoutMs: config.get<number>("requestTimeoutMs", 4000),
    nPrefix: config.get<number>("nPrefix", 256),
    nSuffix: config.get<number>("nSuffix", 64),
    nPredict: config.get<number>("nPredict", 128),
    maxLineSuffix: config.get<number>("maxLineSuffix", 8),
    maxCacheKeys: config.get<number>("maxCacheKeys", 250),
    ringNChunks: config.get<number>("ringNChunks", 16),
    ringChunkSize: config.get<number>("ringChunkSize", 64),
    ringScope: config.get<number>("ringScope", 1024),
    ringUpdateMs: config.get<number>("ringUpdateMs", 1000),
    tMaxPromptMs: config.get<number>("tMaxPromptMs", 500),
    tMaxPredictMs: config.get<number>("tMaxPredictMs", 2500),
  };
}
