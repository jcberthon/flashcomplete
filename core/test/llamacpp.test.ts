import { describe, expect, it } from "vitest";
import { LlamaCppInfillBackend, type LlamaCppConfig } from "../src/backends/llamacpp.js";
import { CompletionError } from "../src/errors.js";
import type { CompletionContext } from "../src/types.js";

const CONFIG: LlamaCppConfig = {
  endpoint: "http://127.0.0.1:8012",
  nPredict: 128,
  tMaxPromptMs: 500,
  tMaxPredictMs: 2500,
  requestTimeoutMs: 4000,
};

const CTX: CompletionContext = {
  inputPrefix: "function add(a, b) {\n",
  inputSuffix: "\n}\n",
  prompt: "  return ",
  chunks: [{ text: "chunk\n", time: 1, filename: "/f.ts" }],
  nIndent: 2,
};

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fn: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const record: RecordedCall = {
      url,
      init: init ?? {},
      body: JSON.parse((init?.body as string | undefined) ?? "{}") as Record<string, unknown>,
    };
    calls.push(record);
    const signal = init?.signal;
    if (signal?.aborted) {
      throw (signal.reason as Error | undefined) ?? new DOMException("Aborted", "AbortError");
    }
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("LlamaCppInfillBackend", () => {
  it("POSTs the ported /infill payload", async () => {
    const { fn, calls } = fakeFetch(() => okResponse({ content: "a + b;" }));
    const backend = new LlamaCppInfillBackend(CONFIG, fn);
    const result = await backend.complete(CTX, new AbortController().signal);

    expect(result.contents).toEqual(["a + b;"]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8012/infill");
    expect(calls[0]?.body).toEqual({
      id_slot: 0,
      input_prefix: "function add(a, b) {\n",
      input_suffix: "\n}\n",
      input_extra: [{ text: "chunk\n", time: 1, filename: "/f.ts" }],
      prompt: "  return ",
      n_predict: 128,
      top_k: 40,
      top_p: 0.99,
      stream: false,
      samplers: ["top_k", "top_p", "infill"],
      cache_prompt: true,
      n_indent: 2,
      t_max_prompt_ms: 500,
      t_max_predict_ms: 2500,
    });
  });

  it("omits n_indent when the context has none", async () => {
    const { fn, calls } = fakeFetch(() => okResponse({ content: "x" }));
    const backend = new LlamaCppInfillBackend(CONFIG, fn);
    await backend.complete({ ...CTX, nIndent: undefined }, new AbortController().signal);
    expect(calls[0]?.body).not.toHaveProperty("n_indent");
  });

  it("normalizes llama.cpp timings into backend-neutral fields", async () => {
    const { fn } = fakeFetch(() =>
      okResponse({
        content: "x",
        tokens_cached: 100,
        timings: {
          prompt_n: 10,
          prompt_ms: 50,
          predicted_n: 20,
          predicted_ms: 200,
          predicted_per_second: 100,
        },
      }),
    );
    const backend = new LlamaCppInfillBackend(CONFIG, fn);
    const result = await backend.complete(CTX, new AbortController().signal);
    expect(result.timings).toEqual({
      promptMs: 50,
      predictMs: 200,
      promptTokens: 10,
      predictedTokens: 20,
      tokensPerSecond: 100,
      cachedTokens: 100,
    });
  });

  it("adds a bearer token only when an API key is configured", async () => {
    const noKey = fakeFetch(() => okResponse({ content: "x" }));
    await new LlamaCppInfillBackend(CONFIG, noKey.fn).complete(CTX, new AbortController().signal);
    expect(noKey.calls[0]?.init.headers).not.toHaveProperty("Authorization");

    const withKey = fakeFetch(() => okResponse({ content: "x" }));
    await new LlamaCppInfillBackend({ ...CONFIG, apiKey: "secret" }, withKey.fn).complete(
      CTX,
      new AbortController().signal,
    );
    expect((withKey.calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret",
    );
  });

  it("trims a trailing slash from the endpoint", async () => {
    const { fn, calls } = fakeFetch(() => okResponse({ content: "x" }));
    const backend = new LlamaCppInfillBackend({ ...CONFIG, endpoint: "http://host:8012/" }, fn);
    await backend.complete(CTX, new AbortController().signal);
    expect(calls[0]?.url).toBe("http://host:8012/infill");
    expect(backend.identity()).toBe("http://host:8012");
  });

  it("throws a config error when no endpoint is set", async () => {
    const { fn, calls } = fakeFetch(() => okResponse({}));
    const backend = new LlamaCppInfillBackend({ ...CONFIG, endpoint: "  " }, fn);
    await expect(backend.complete(CTX, new AbortController().signal)).rejects.toMatchObject({
      kind: "config",
    });
    expect(calls.length).toBe(0);
  });

  it("maps HTTP statuses to actionable errors", async () => {
    for (const [status, kind, hintFragment] of [
      [401, "http", "API key"],
      [404, "http", "llama.cpp"],
      [500, "http", undefined],
    ] as const) {
      const { fn } = fakeFetch(() => new Response("nope", { status }));
      const backend = new LlamaCppInfillBackend(CONFIG, fn);
      const error = await backend
        .complete(CTX, new AbortController().signal)
        .then(() => undefined)
        .catch((err: unknown) => err as CompletionError);
      expect(error?.kind).toBe(kind);
      expect(error?.status).toBe(status);
      if (hintFragment) expect(error?.hint).toContain(hintFragment);
    }
  });

  it("classifies an aborted request", async () => {
    const { fn } = fakeFetch(() => okResponse({}));
    const backend = new LlamaCppInfillBackend(CONFIG, fn);
    const controller = new AbortController();
    controller.abort();
    await expect(backend.complete(CTX, controller.signal)).rejects.toMatchObject({
      kind: "aborted",
    });
  });

  it("times out client-side when the server hangs", async () => {
    const { fn } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error), {
            once: true,
          });
        }),
    );
    const backend = new LlamaCppInfillBackend({ ...CONFIG, requestTimeoutMs: 20 }, fn);
    await expect(backend.complete(CTX, new AbortController().signal)).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("classifies connection failures as network errors", async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    const backend = new LlamaCppInfillBackend(CONFIG, fn);
    await expect(backend.complete(CTX, new AbortController().signal)).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("sends the KV warm-up payload with n_predict 0", async () => {
    const { fn, calls } = fakeFetch(() => okResponse({}));
    const backend = new LlamaCppInfillBackend(CONFIG, fn);
    backend.warmContext([{ text: "chunk\n", time: 1, filename: "/f.ts" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls[0]?.body).toEqual({
      id_slot: 0,
      input_prefix: "",
      input_suffix: "",
      input_extra: [{ text: "chunk\n", time: 1, filename: "/f.ts" }],
      prompt: "",
      n_predict: 0,
      samplers: [],
      cache_prompt: true,
      t_max_prompt_ms: 500,
      t_max_predict_ms: 1,
    });
  });

  it("swallows warm-up failures silently", async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    const backend = new LlamaCppInfillBackend(CONFIG, fn);
    expect(() => backend.warmContext([{ text: "c\n", time: 1, filename: "/f.ts" }])).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
