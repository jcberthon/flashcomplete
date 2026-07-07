# Changelog

## 0.9.0 — first release

Scope: llama.cpp `/infill` backend only; the user launches `llama-server`
manually and points `flashcomplete.endpoint` at it.

### Engine (`core/`, IDE-agnostic)

- `CompletionBackend` interface with a capability model (`fim`, `streaming`,
  `contextInjection`, `kvWarmup`, …) — new backends are new files, zero engine
  changes
- Completion pipeline ported from llama.vscode: debounce → cache → backend →
  post-process (repeat-discard heuristics, suffix trimming) → speculative
  prefetch of post-accept states
- LRU completion cache with prompt-prefix reuse; cache key includes backend +
  endpoint identity (fixes the upstream stale-completion-across-model-switch bug)
- Cancel-previous request lifecycle with `AbortController` and a client-side
  timeout (replaces upstream's busy-wait single-flight and missing timeout)
- Ring-buffer context gathering with Jaccard-similarity eviction; llama.cpp
  KV-cache warm-up as an optional backend capability
- Typed error taxonomy (config / network / timeout / aborted / http)
- 69 unit tests (Vitest)

### VS Code adapter (`adapters/vscode/`)

- Inline completion provider wired to the engine; CancellationToken mapped to
  AbortSignal
- Commands: manual trigger, bypass-cache trigger, accept first line / next word
  (via VS Code's native partial-accept), enable/disable toggle
- Statusbar with backend-neutral timings; config errors get one actionable
  message, transient errors stay in the statusbar
- Settings under `flashcomplete.*` with llama.vscode's proven defaults
- esbuild single-file bundle; packaged as `flashcomplete-0.9.0.vsix` (~15 KB)

### Tooling

- npm workspaces monorepo; `npm run verify` = Prettier check + ESLint
  (type-checked rules + a rule forbidding `vscode` imports in `core/`) + strict
  tsc + Vitest
