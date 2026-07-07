// SPDX-License-Identifier: MIT
// Portions ported from llama.vscode (https://github.com/ggml-org/llama.vscode),
// MIT License, Copyright (c) 2025 The llama.vscode contributors.
// See ATTRIBUTIONS.md for details.
import type { CompletionBackend } from "../backend.js";
import { classifyFetchError, CompletionError } from "../errors.js";
import type {
  BackendCapabilities,
  BackendResult,
  CompletionContext,
  ContextChunk,
  NormalizedTimings,
} from "../types.js";

export interface LlamaCppConfig {
  /** Base URL of a manually launched llama.cpp server (e.g. http://127.0.0.1:8012). */
  endpoint: string;
  /** Only needed when the server was started with --api-key. */
  apiKey?: string;
  nPredict: number;
  /** Server-side hints, honored by llama.cpp only. */
  tMaxPromptMs: number;
  tMaxPredictMs: number;
  /** Client-side hard timeout per request. */
  requestTimeoutMs: number;
}

/** Response shape of llama.cpp's /infill endpoint (the fields we consume). */
interface LlamaCppResponse {
  content?: string;
  tokens_cached?: number;
  timings?: {
    prompt_n?: number;
    prompt_ms?: number;
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_second?: number;
  };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeTimings(data: LlamaCppResponse): NormalizedTimings | undefined {
  const timings = data.timings;
  if (!timings && data.tokens_cached === undefined) return undefined;
  return {
    promptMs: timings?.prompt_ms,
    predictMs: timings?.predicted_ms,
    promptTokens: timings?.prompt_n,
    predictedTokens: timings?.predicted_n,
    tokensPerSecond: timings?.predicted_per_second,
    cachedTokens: data.tokens_cached,
  };
}

/**
 * Backend for llama.cpp's native /infill endpoint. Payload shape ported from
 * llama.vscode's createRequestPayload (llama-server.ts); unlike the original,
 * every request carries an AbortSignal and a client-side timeout.
 */
export class LlamaCppInfillBackend implements CompletionBackend {
  readonly id = "llamacpp";
  private readonly config: LlamaCppConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: LlamaCppConfig, fetchFn: typeof fetch = fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  capabilities(): BackendCapabilities {
    return {
      fim: true,
      chatFallback: false,
      streaming: false,
      contextInjection: true,
      kvWarmup: true,
    };
  }

  identity(): string {
    // The endpoint identifies the server. llama.cpp serves one model per
    // instance; probing the loaded model (/props) for a stronger identity is
    // planned for v1.0 (docs/FUTURE_WORK.md).
    return trimTrailingSlash(this.config.endpoint);
  }

  async complete(ctx: CompletionContext, signal: AbortSignal): Promise<BackendResult> {
    const url = this.infillUrl();
    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.payload(ctx, false)),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
      });
      if (!response.ok) {
        throw this.httpError(response.status);
      }
      const data = (await response.json()) as LlamaCppResponse;
      return { contents: [data.content ?? ""], timings: normalizeTimings(data) };
    } catch (err) {
      throw classifyFetchError(err);
    }
  }

  /** Warm the server's KV cache with the current ring chunks (fire-and-forget). */
  warmContext(chunks: ContextChunk[]): void {
    void this.fetchFn(this.infillUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(
        this.payload({ inputPrefix: "", inputSuffix: "", prompt: "", chunks }, true),
      ),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    }).catch(() => {
      // Warm-ups are best-effort; the next completion will surface real errors.
    });
  }

  private infillUrl(): string {
    const endpoint = this.config.endpoint.trim();
    if (endpoint === "") {
      throw new CompletionError("config", "No completion endpoint configured", {
        hint: "Set the endpoint of a running llama.cpp server.",
      });
    }
    return `${trimTrailingSlash(endpoint)}/infill`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.config.apiKey?.trim() && { Authorization: `Bearer ${this.config.apiKey.trim()}` }),
    };
  }

  private payload(ctx: CompletionContext, noPredict: boolean): Record<string, unknown> {
    if (noPredict) {
      return {
        id_slot: 0,
        input_prefix: ctx.inputPrefix,
        input_suffix: ctx.inputSuffix,
        input_extra: ctx.chunks,
        prompt: ctx.prompt,
        n_predict: 0,
        samplers: [],
        cache_prompt: true,
        t_max_prompt_ms: this.config.tMaxPromptMs,
        t_max_predict_ms: 1,
      };
    }
    return {
      id_slot: 0,
      input_prefix: ctx.inputPrefix,
      input_suffix: ctx.inputSuffix,
      input_extra: ctx.chunks,
      prompt: ctx.prompt,
      n_predict: this.config.nPredict,
      top_k: 40,
      top_p: 0.99,
      stream: false,
      samplers: ["top_k", "top_p", "infill"],
      cache_prompt: true,
      ...(ctx.nIndent && { n_indent: ctx.nIndent }),
      t_max_prompt_ms: this.config.tMaxPromptMs,
      t_max_predict_ms: this.config.tMaxPredictMs,
    };
  }

  private httpError(status: number): CompletionError {
    if (status === 401 || status === 403) {
      return new CompletionError(
        "http",
        `Completion server rejected the request (HTTP ${status})`,
        {
          status,
          hint: "Check the API key.",
        },
      );
    }
    if (status === 404) {
      return new CompletionError("http", "The server has no /infill endpoint (HTTP 404)", {
        status,
        hint: "Is the endpoint a llama.cpp server with a FIM-capable model?",
      });
    }
    return new CompletionError("http", `Completion request failed (HTTP ${status})`, { status });
  }
}
