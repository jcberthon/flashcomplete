import { describe, expect, it } from "vitest";
import type { CompletionBackend } from "../src/backend.js";
import { CompletionCache } from "../src/cache.js";
import { buildLocalContext, ContextRing } from "../src/context.js";
import { CompletionEngine } from "../src/engine.js";
import { CompletionError } from "../src/errors.js";
import type {
  BackendResult,
  CompletionContext,
  DocumentSnapshot,
  EngineConfig,
  StatusEvent,
} from "../src/types.js";

const CONFIG: EngineConfig = { debounceMs: 0, nPrefix: 8, nSuffix: 8, maxLineSuffix: 8 };
const RING_CONFIG = {
  nChunks: 4,
  chunkSize: 8,
  scope: 64,
  nPrefix: 8,
  nSuffix: 8,
  updateMinTimeMs: 0,
};

/** Cursor mid-function with an empty line suffix (prefetch enabled). */
const SNAPSHOT: DocumentSnapshot = {
  lines: ["function add(a, b) {", "  return ", "}"],
  cursorLine: 1,
  cursorChar: 9,
  fileName: "/test/file.ts",
};

/** Cursor with a short non-blank line suffix (suppresses speculative prefetch). */
const SNAPSHOT_NO_PREFETCH: DocumentSnapshot = {
  lines: ["function add(a, b) {", "  return (x)", "}"],
  cursorLine: 1,
  cursorChar: 9,
  fileName: "/test/file.ts",
};

interface FakeBackendOptions {
  contents?: string[] | ((call: number, ctx: CompletionContext) => string[]);
  identityValue?: string;
  kvWarmup?: boolean;
  failWith?: CompletionError;
  hangUntilAbort?: (call: number) => boolean;
}

interface FakeBackend extends CompletionBackend {
  calls: CompletionContext[];
  warmed: number;
}

function makeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const calls: CompletionContext[] = [];
  const backend: FakeBackend = {
    id: "fake",
    calls,
    warmed: 0,
    identity: () => options.identityValue ?? "endpoint-A",
    capabilities: () => ({
      fim: true,
      chatFallback: false,
      streaming: false,
      contextInjection: true,
      kvWarmup: options.kvWarmup ?? false,
    }),
    complete(ctx: CompletionContext, signal: AbortSignal): Promise<BackendResult> {
      const call = calls.length;
      calls.push(ctx);
      if (options.failWith) return Promise.reject(options.failWith);
      if (options.hangUntilAbort?.(call)) {
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new CompletionError("aborted", "aborted")),
            { once: true },
          );
        });
      }
      const contents =
        typeof options.contents === "function"
          ? options.contents(call, ctx)
          : (options.contents ?? ["a + b;"]);
      return Promise.resolve({ contents, timings: { predictMs: 12 } });
    },
    warmContext() {
      backend.warmed++;
    },
  };
  return backend;
}

function makeEngine(backend: CompletionBackend, config: EngineConfig = CONFIG) {
  const cache = new CompletionCache(50);
  const ring = new ContextRing(RING_CONFIG);
  const events: StatusEvent[] = [];
  const engine = new CompletionEngine({
    backend,
    cache,
    ring,
    config,
    onStatus: (event) => events.push(event),
  });
  return { engine, cache, ring, events };
}

describe("CompletionEngine", () => {
  it("returns a suggestion and passes the assembled FIM context to the backend", async () => {
    const backend = makeBackend({ contents: ["a + b;"] });
    const { engine, events } = makeEngine(backend);
    const outcome = await engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    expect(outcome.status).toBe("suggested");
    if (outcome.status !== "suggested") return;
    expect(outcome.fromCache).toBe(false);
    expect(outcome.timings?.predictMs).toBe(12);
    const ctx = backend.calls[0];
    expect(ctx?.inputPrefix).toBe("function add(a, b) {\n");
    expect(ctx?.inputSuffix).toBe("(x)\n}\n");
    expect(ctx?.prompt).toBe("  return ");
    expect(ctx?.nIndent).toBe(2);
    expect(events.map((event) => event.state)).toEqual(["thinking", "done"]);
  });

  it("serves the identical request from the cache without a backend call", async () => {
    const backend = makeBackend({ contents: ["a + b)"] });
    const { engine, events } = makeEngine(backend);
    const first = await engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    if (first.status === "suggested") await first.background;
    const callsAfterFirst = backend.calls.length;

    const second = await engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    expect(second.status).toBe("suggested");
    if (second.status !== "suggested") return;
    expect(second.fromCache).toBe(true);
    if (second.background) await second.background;
    expect(backend.calls.length).toBe(callsAfterFirst);
    expect(events.at(-1)?.state).toBe("cached");
  });

  it("misses the cache when the backend identity changes (stale-completion regression)", async () => {
    const backendA = makeBackend({ contents: ["a + b)"], identityValue: "endpoint-A" });
    const { engine: engineA, cache } = makeEngine(backendA);
    const first = await engineA.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    if (first.status === "suggested") await first.background;

    const backendB = makeBackend({ contents: ["b + a)"], identityValue: "endpoint-B" });
    const engineB = new CompletionEngine({
      backend: backendB,
      cache,
      ring: new ContextRing(RING_CONFIG),
      config: CONFIG,
    });
    const second = await engineB.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    expect(second.status).toBe("suggested");
    if (second.status !== "suggested") return;
    expect(second.fromCache).toBe(false);
    expect(backendB.calls.length).toBeGreaterThan(0);
  });

  it("bypasses the cache when requested", async () => {
    const backend = makeBackend({ contents: ["a + b)"] });
    const { engine } = makeEngine(backend);
    const first = await engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    if (first.status === "suggested") await first.background;
    const callsAfterFirst = backend.calls.length;

    const second = await engine.complete({
      snapshot: SNAPSHOT_NO_PREFETCH,
      trigger: "manual",
      bypassCache: true,
    });
    expect(second.status).toBe("suggested");
    if (second.status !== "suggested") return;
    expect(second.fromCache).toBe(false);
    expect(backend.calls.length).toBe(callsAfterFirst + 1);
  });

  it("aborts the in-flight request when a new one arrives", async () => {
    const backend = makeBackend({ contents: ["a + b)"], hangUntilAbort: (call) => call === 0 });
    const { engine } = makeEngine(backend);
    const firstPromise = engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    const secondPromise = engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toEqual({ status: "skipped", reason: "cancelled" });
    expect(second.status).toBe("suggested");
  });

  it("skips immediately when the external signal is already aborted", async () => {
    const backend = makeBackend();
    const { engine } = makeEngine(backend);
    const controller = new AbortController();
    controller.abort();
    const outcome = await engine.complete(
      { snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" },
      controller.signal,
    );
    expect(outcome).toEqual({ status: "skipped", reason: "cancelled" });
    expect(backend.calls.length).toBe(0);
  });

  it("cancels during the debounce window when superseded", async () => {
    const backend = makeBackend({ contents: ["a + b)"] });
    const { engine } = makeEngine(backend, { ...CONFIG, debounceMs: 20 });
    const firstPromise = engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "auto" });
    const secondPromise = engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "auto" });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toEqual({ status: "skipped", reason: "cancelled" });
    expect(second.status).toBe("suggested");
    expect(backend.calls.length).toBe(1);
  });

  it("skips automatic completion when the line suffix is too long", async () => {
    const snapshot: DocumentSnapshot = {
      lines: ["const x = foo(bar, baz, qux)"],
      cursorLine: 0,
      cursorChar: 10,
      fileName: "/test/file.ts",
    };
    const backend = makeBackend();
    const { engine } = makeEngine(backend);
    expect(await engine.complete({ snapshot, trigger: "auto" })).toEqual({
      status: "skipped",
      reason: "line-suffix",
    });
    // A manual trigger overrides the gate.
    const manual = await engine.complete({ snapshot, trigger: "manual" });
    expect(manual.status).toBe("suggested");
  });

  it("returns empty when the backend produces only discardable content", async () => {
    const backend = makeBackend({ contents: ["   "] });
    const { engine, events } = makeEngine(backend);
    const outcome = await engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    expect(outcome.status).toBe("empty");
    expect(events.map((event) => event.state)).toEqual(["thinking", "empty"]);
  });

  it("surfaces classified backend errors", async () => {
    const failure = new CompletionError("network", "Cannot reach the completion server", {
      hint: "Is the server running?",
    });
    const backend = makeBackend({ failWith: failure });
    const { engine, events } = makeEngine(backend);
    const outcome = await engine.complete({ snapshot: SNAPSHOT_NO_PREFETCH, trigger: "manual" });
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.kind).toBe("network");
    expect(events.at(-1)?.state).toBe("error");
  });

  it("strips the blanked-prompt indentation from returned suggestions", async () => {
    const snapshot: DocumentSnapshot = {
      lines: ["function f() {", "    ", "}"],
      cursorLine: 1,
      cursorChar: 4,
      fileName: "/test/file.ts",
    };
    const backend = makeBackend({ contents: ["    const x = 1;"] });
    const { engine } = makeEngine(backend);
    const outcome = await engine.complete({ snapshot, trigger: "manual" });
    expect(outcome.status).toBe("suggested");
    if (outcome.status !== "suggested") return;
    expect(outcome.suggestions).toEqual(["const x = 1;"]);
  });

  it("prefetches the post-accept states into the cache", async () => {
    const backend = makeBackend({
      contents: (call) => (call === 0 ? ["a + b;\nconsole.log(a);"] : ["// prefetched"]),
    });
    const { engine, cache } = makeEngine(backend);
    const outcome = await engine.complete({ snapshot: SNAPSHOT, trigger: "manual" });
    expect(outcome.status).toBe("suggested");
    if (outcome.status !== "suggested") return;
    await outcome.background;
    // one main call + one speculative prefetch call
    expect(backend.calls.length).toBe(2);

    // Accept-first-line state was seeded without a server call:
    const local = buildLocalContext(SNAPSHOT, CONFIG);
    const identity = "fake|endpoint-A";
    const lineAcceptPrefix = local.inputPrefix + local.prompt + "a + b;\n";
    expect(cache.get(identity, lineAcceptPrefix, local.inputSuffix, "")).toEqual([
      "console.log(a);",
    ]);
  });

  it("warms the backend cache from the ring only when the capability exists", () => {
    const warmable = makeBackend({ kvWarmup: true });
    const { engine, ring } = makeEngine(warmable);
    ring.pickChunk(["l1", "l2", "l3"], "f.ts", false, 0);
    engine.warmTick(10_000);
    expect(warmable.warmed).toBe(1);

    const cold = makeBackend({ kvWarmup: false });
    const { engine: coldEngine, ring: coldRing } = makeEngine(cold);
    coldRing.pickChunk(["l1", "l2", "l3"], "f.ts", false, 0);
    coldEngine.warmTick(10_000);
    expect(cold.warmed).toBe(0);
  });
});
