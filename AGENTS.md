# AGENTS.md

## Project

FlashComplete — a local-first, model-agnostic, ultra-fast inline completion engine.
Works with llama.cpp, Ollama, and any OpenAI-compatible server. Native FIM when
available, intelligent fallback (completion endpoint, then chat-completion prompt)
otherwise. No chat, no agents, no cloud. One IDE adapter today (VS Code), designed
so a second one is a small, isolated addition.

## Non-negotiable architectural rule

`/core` must never import an IDE-specific module (no `vscode`, no JetBrains SDK,
etc.) and must never assume one vendor's wire format. `/core` depends only on the
`CompletionBackend` interface, plain TS/JS, and unavoidable Node built-ins. If a
change to `/core` seems to require an IDE-specific import, stop — that logic
belongs in an adapter, not the engine.

## Directory layout

```
/core                      engine: CompletionBackend interface, cache, context
                           builder, request lifecycle (debounce/cancel/timeout)
/core/backends             LlamaCppInfillBackend, OllamaBackend,
                           OpenAICompatibleBackend, ChatFallbackBackend
/adapters/vscode           VS Code extension: activation, inline completion
                           provider, settings, statusbar — thin, IDE-only glue
/adapters/<future-ide>     sibling adapters land here, calling only /core's
                           public API
/reference/llama-vscode    READ-ONLY. Ported reference source from
                           github.com/ggml-org/llama.vscode (MIT). Consult for
                           algorithms (speculative cache, ring-buffer context,
                           prompt-prefix reuse). Do not build on top of it
                           directly — port logic into /core deliberately.
docs/ARCHITECTURE-REVIEW.md   analysis of llama.vscode and the case for this project
AGENTS.md                  this file
README.md                  project pitch and status
```

## Backend abstraction contract

Every backend implements roughly:

```ts
interface CompletionBackend {
  capabilities(): BackendCapabilities; // fim, chatFallback, streaming, cancellation, contextInjection
  complete(ctx: CompletionContext, signal: AbortSignal): Promise<CompletionResult>;
  warmContext?(chunks: ContextChunk[]): void; // optional, e.g. KV-cache warm-up
}
```

Strategy selection (native FIM → completion endpoint → chat-completion prompt)
happens once, based on `capabilities()` — never as inline `if (backend === X)`
branching inside the engine. A new backend is a new file under `/core/backends`;
it should require zero changes to the engine itself.

## Lessons carried over from llama.vscode (see docs/ARCHITECTURE-REVIEW.md)

- The completion cache key **must** include model/endpoint identity. A plain
  `prefix|suffix|prompt` hash will serve stale completions across a model switch.
- Every backend request needs a client-side `AbortController` and timeout. Don't
  rely on server-side hints alone, and don't serialize requests by polling a busy
  flag — cancel the in-flight one instead.
- No service-locator singleton for `/core`. Pass explicit dependencies (cache,
  backend, config slice) into the engine so it stays unit-testable.
- Don't let status/telemetry assume one backend's response shape (e.g.
  llama.cpp-specific timing fields). Normalize in `/core`.
- Treat `/reference/llama-vscode` as frozen. Update it only by re-copying from
  upstream, never by hand-editing.

## Build & test

_TODO once tooling is chosen — assuming pnpm workspaces:_
- `pnpm install`
- `pnpm -F core test`
- `pnpm -F adapters-vscode build` / `pnpm -F adapters-vscode package`

## Scope discipline

No chat UI, no multi-turn agents, no RAG/embeddings, no tool-calling. If a change
starts growing in that direction, it belongs in a different project. Keep the
footprint small enough to read in one sitting.
