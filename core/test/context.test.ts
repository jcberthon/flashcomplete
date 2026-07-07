import { describe, expect, it } from "vitest";
import {
  buildLocalContext,
  ContextRing,
  getPrefixLines,
  getSuffixLines,
  jaccardSimilarity,
} from "../src/context.js";
import type { DocumentSnapshot, EngineConfig } from "../src/types.js";

function snap(lines: string[], cursorLine: number, cursorChar: number): DocumentSnapshot {
  return { lines, cursorLine, cursorChar, fileName: "/test/file.ts" };
}

const CONFIG: EngineConfig = { debounceMs: 0, nPrefix: 2, nSuffix: 2, maxLineSuffix: 8 };

describe("prefix/suffix extraction", () => {
  const lines = ["l0", "l1", "l2", "l3", "l4"];

  it("returns the window of lines before the cursor", () => {
    expect(getPrefixLines(snap(lines, 3, 0), 2)).toEqual(["l1", "l2"]);
  });

  it("clamps the prefix window at the top of the file", () => {
    expect(getPrefixLines(snap(lines, 1, 0), 10)).toEqual(["l0"]);
    expect(getPrefixLines(snap(lines, 0, 0), 10)).toEqual([]);
  });

  it("returns the window of lines after the cursor", () => {
    expect(getSuffixLines(snap(lines, 1, 0), 2)).toEqual(["l2", "l3"]);
  });

  it("clamps the suffix window at the end of the file", () => {
    expect(getSuffixLines(snap(lines, 3, 0), 10)).toEqual(["l4"]);
    expect(getSuffixLines(snap(lines, 4, 0), 10)).toEqual([]);
  });
});

describe("buildLocalContext", () => {
  it("assembles prefix, suffix and prompt around the cursor", () => {
    const lines = ["function add(a, b) {", "  return a", "}"];
    const local = buildLocalContext(snap(lines, 1, 10), CONFIG);
    expect(local.inputPrefix).toBe("function add(a, b) {\n");
    expect(local.inputSuffix).toBe("\n}\n");
    expect(local.prompt).toBe("  return a");
    expect(local.linePrefix).toBe("  return a");
    expect(local.lineSuffix).toBe("");
    expect(local.nIndent).toBe(2);
    expect(local.spacesToRemove).toBe(0);
  });

  it("blanks a whitespace-only prompt and records the spaces to strip", () => {
    const lines = ["function add(a, b) {", "    ", "}"];
    const local = buildLocalContext(snap(lines, 1, 4), CONFIG);
    expect(local.prompt).toBe("");
    expect(local.spacesToRemove).toBe(4);
  });

  it("splits the cursor line into prompt and line suffix", () => {
    const lines = ["const x = foo(bar)"];
    const local = buildLocalContext(snap(lines, 0, 13), CONFIG);
    expect(local.prompt).toBe("const x = foo");
    expect(local.lineSuffix).toBe("(bar)");
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical chunks and empty chunks", () => {
    expect(jaccardSimilarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccardSimilarity([], [])).toBe(1);
  });

  it("is 0 for disjoint chunks", () => {
    expect(jaccardSimilarity(["a"], ["b"])).toBe(0);
  });

  it("is fractional for overlapping chunks", () => {
    expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
  });
});

describe("ContextRing", () => {
  const RING = {
    nChunks: 3,
    chunkSize: 64,
    scope: 100,
    nPrefix: 2,
    nSuffix: 2,
    updateMinTimeMs: 0,
  };
  const CHUNK = ["line one", "line two", "line three", "line four"];

  it("ignores chunks smaller than 3 lines", () => {
    const ring = new ContextRing(RING);
    ring.pickChunk(["a", "b"], "f.ts", false, 0);
    expect(ring.queuedCount()).toBe(0);
  });

  it("queues a chunk and drains it into the active ring", () => {
    const ring = new ContextRing(RING);
    ring.pickChunk(CHUNK, "f.ts", false, 0);
    expect(ring.queuedCount()).toBe(1);
    const chunks = ring.drainOne(10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks?.[0]?.text).toBe(CHUNK.join("\n") + "\n");
    expect(ring.chunks).toHaveLength(1);
    expect(ring.drainOne(10_000)).toBeUndefined();
  });

  it("does not drain right after a completion started", () => {
    const ring = new ContextRing({ ...RING, updateMinTimeMs: 3000 });
    ring.pickChunk(CHUNK, "f.ts", false, 0);
    ring.markCompletionStart(10_000);
    expect(ring.drainOne(11_000)).toBeUndefined();
    expect(ring.drainOne(14_000)).toHaveLength(1);
  });

  it("drops identical chunks when eviction is enabled", () => {
    const ring = new ContextRing(RING);
    ring.pickChunk(CHUNK, "f.ts", true, 0);
    ring.pickChunk(CHUNK, "f.ts", true, 0);
    expect(ring.queuedCount()).toBe(1);
  });

  it("evicts near-duplicate chunks (Jaccard > 0.9) from the active ring", () => {
    const ring = new ContextRing(RING);
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    ring.pickChunk(lines, "f.ts", false, 0);
    ring.drainOne(10_000);
    expect(ring.chunks).toHaveLength(1);
    // 19 shared lines over a 21-line union → similarity ≈ 0.905 > 0.9
    ring.pickChunk([...lines.slice(0, 19), "line 99"], "f.ts", true, 0);
    expect(ring.chunks).toHaveLength(0);
    expect(ring.queuedCount()).toBe(1);
  });

  it("caps the queue, dropping the oldest chunk", () => {
    const ring = new ContextRing({ ...RING, maxQueuedChunks: 2 });
    ring.pickChunk(["a1", "a2", "a3"], "f.ts", false, 0);
    ring.pickChunk(["b1", "b2", "b3"], "f.ts", false, 0);
    ring.pickChunk(["c1", "c2", "c3"], "f.ts", false, 0);
    expect(ring.queuedCount()).toBe(2);
    expect(ring.drainOne(10_000)?.[0]?.text).toBe("b1\nb2\nb3\n");
  });

  it("caps the active ring at nChunks", () => {
    const ring = new ContextRing({ ...RING, nChunks: 2 });
    for (const label of ["a", "b", "c"]) {
      ring.pickChunk([`${label}1`, `${label}2`, `${label}3`], "f.ts", false, 0);
      ring.drainOne(10_000);
    }
    expect(ring.chunks.map((chunk) => chunk.text)).toEqual(["b1\nb2\nb3\n", "c1\nc2\nc3\n"]);
  });

  it("slices large chunks to half the chunk size using the injected rng", () => {
    const ring = new ContextRing({ ...RING, chunkSize: 4 }, () => 0);
    const lines = ["x0", "x1", "x2", "x3", "x4", "x5"];
    ring.pickChunk(lines, "f.ts", false, 0);
    const chunks = ring.drainOne(10_000);
    // rng() = 0 → start at line 0, take chunkSize / 2 = 2 lines
    expect(chunks?.[0]?.text).toBe("x0\nx1\n");
  });

  it("gathers far-context chunks only after the cursor moved far", () => {
    const ring = new ContextRing({ ...RING, updateMinTimeMs: 0 });
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    ring.pickChunksAfterCompletion(snap(lines, 100, 0), 0);
    const afterFirst = ring.queuedCount();
    expect(afterFirst).toBeGreaterThan(0);
    // Cursor moved only a little since the last pick → nothing new.
    ring.pickChunksAfterCompletion(snap(lines, 105, 0), 0);
    expect(ring.queuedCount()).toBe(afterFirst);
  });
});
