import { describe, expect, it } from "vitest";
import { CompletionCache, LRUCache } from "../src/cache.js";

describe("LRUCache", () => {
  it("rejects a non-positive capacity", () => {
    expect(() => new LRUCache(0)).toThrow();
  });

  it("stores and retrieves values", () => {
    const cache = new LRUCache(2);
    cache.put("a", ["1"]);
    expect(cache.get("a")).toEqual(["1"]);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts the least recently used entry beyond capacity", () => {
    const cache = new LRUCache(2);
    cache.put("a", ["1"]);
    cache.put("b", ["2"]);
    cache.put("c", ["3"]);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual(["2"]);
    expect(cache.get("c")).toEqual(["3"]);
  });

  it("refreshes recency on get", () => {
    const cache = new LRUCache(2);
    cache.put("a", ["1"]);
    cache.put("b", ["2"]);
    cache.get("a");
    cache.put("c", ["3"]);
    expect(cache.get("a")).toEqual(["1"]);
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("CompletionCache", () => {
  const ID_A = "llamacpp|http://127.0.0.1:8012";
  const ID_B = "llamacpp|http://127.0.0.1:9999";

  it("round-trips completions", () => {
    const cache = new CompletionCache(10);
    cache.put(ID_A, "prefix\n", "suffix\n", "const x", ["= 1;"]);
    expect(cache.get(ID_A, "prefix\n", "suffix\n", "const x")).toEqual(["= 1;"]);
  });

  it("misses when backend/server identity differs (stale-completion regression)", () => {
    // llama.vscode keyed only on prefix|suffix|prompt, so switching model or
    // endpoint could serve completions from the previous model. The identity
    // must be part of the key.
    const cache = new CompletionCache(10);
    cache.put(ID_A, "prefix\n", "suffix\n", "const x", ["= 1;"]);
    expect(cache.get(ID_B, "prefix\n", "suffix\n", "const x")).toBeUndefined();
    expect(cache.getWithPrefixReuse(ID_B, "prefix\n", "suffix\n", "const x")).toBeUndefined();
  });

  it("reuses a cached completion while the user types along with it", () => {
    const cache = new CompletionCache(10);
    cache.put(ID_A, "prefix\n", "suffix\n", "co", ["nsole.log(x)"]);
    // The user typed "ns" since the completion was cached.
    expect(cache.getWithPrefixReuse(ID_A, "prefix\n", "suffix\n", "cons")).toEqual(["ole.log(x)"]);
  });

  it("does not reuse when the typed text diverges from the cached completion", () => {
    const cache = new CompletionCache(10);
    cache.put(ID_A, "prefix\n", "suffix\n", "co", ["nsole.log(x)"]);
    expect(cache.getWithPrefixReuse(ID_A, "prefix\n", "suffix\n", "cor")).toBeUndefined();
  });

  it("prefers the exact match over prefix reuse", () => {
    const cache = new CompletionCache(10);
    cache.put(ID_A, "p\n", "s\n", "co", ["nsole"]);
    cache.put(ID_A, "p\n", "s\n", "cons", ["t x = 1;"]);
    expect(cache.getWithPrefixReuse(ID_A, "p\n", "s\n", "cons")).toEqual(["t x = 1;"]);
  });
});
