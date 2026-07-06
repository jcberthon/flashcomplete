# FlashComplete — llama.vscode Architectural Review

## Context

The user is evaluating whether `llama.vscode` (ggml-org, MIT, ~15k LOC TS) can serve as the foundation for **FlashComplete**: a local-first, model-agnostic, ultra-fast inline completion engine (llama.cpp / Ollama / OpenAI-compatible; FIM + instruct + chat fallback; no chat, no agents, tiny footprint). This document is the requested 4-phase report. It is an analysis deliverable — no code changes are proposed for this session.

Central question: *what minimally has to change to swap the completion engine?* Answer in one line: **one seam — `LlamaServer.getFIMCompletion()` in `src/llama-server.ts:774` — plus the config knobs that feed it.** Everything above that line (provider registration, debounce, cache, post-processing, ghost text) is backend-agnostic.

---

# Phase 1 — Architectural inventory

## 1. High-level architecture

```
                         VS Code editor (typing / manual trigger)
                                        │
                                        ▼
        vscode.languages.registerInlineCompletionItemProvider (pattern '**')
                       architect.ts:307 setCompletionProvider
                                        │  gate: configuration.isCompletionEnabled
                                        ▼
                     Completion.getCompletionItems  (completion.ts:26)
        ┌───────────────────────────────┼───────────────────────────────────┐
        │ debounce / single-flight      │ prefix+suffix gathering            │
        │ LRU result cache lookup ◄─────┤ (utils.ts getPrefixLines/Suffix)   │
        │ (lru-cache.ts, sha256 key)    │                                    │
        └───────────────┬───────────────┘                                    │
                        │ cache miss                                         │
                        ▼                                                    │
          LlamaServer.getFIMCompletion  (llama-server.ts:774)   ◄── chunks ──┤
                        │                                                    │
        ┌───────────────┴────────────────┐                                   │
        │ use_openai_endpoint=false      │ use_openai_endpoint=true          │
        ▼                                ▼                                   │
  POST {endpoint}/infill          OpenAI SDK /v1/completions                 │
  (llama.cpp proprietary:         (openai_prompt_template FIM string,        │
   input_prefix/suffix,            "experimental" path)                      │
   input_extra, n_indent,                                                    │
   cache_prompt, t_max_*)                                                    │
        │                                │                                   │
        └───────────────┬────────────────┘                                   │
                        ▼                                                    │
     post-process: shouldDiscardSuggestion / updateSuggestion                │
     cache put + speculative prefetch (cacheFutureSuggestion)                │
                        │                                                    │
                        ▼                                                    │
        vscode.InlineCompletionItem[] ──► VS Code renders ghost text         │
                                                                             │
  ExtraContext ring buffer (extra-context.ts) ───────────────────────────────┘
    fed by: file save, editor switch, copy/cut intercept, distant cursor moves
    drained every 1s (setPeriodicRingBufferUpdate) + KV-cache warm-up
    via LlamaServer.updateExtraContext → POST /infill n_predict:0
```

Statusbar (`statusbar.ts`) displays llama.cpp timing fields. Configuration (`configuration.ts`) is a flat settings bag injected everywhere via the `Application` singleton (`application.ts`, service locator).

## 2. Completion pipeline (keystroke → ghost text)

1. **User types** → VS Code invokes the anonymous provider registered in `architect.ts:307` (`setCompletionProvider`), which checks `Configuration.isCompletionEnabled` (configuration.ts:457) and delegates to `Completion.getCompletionItems` (completion.ts:26).
2. **Manual-mode gate** (completion.ts:28): if `auto=false`, automatic triggers return null.
3. **Debounce** (completion.ts:34): `Utils.delay(debounce_ms)` (default **0**), then cancellation-token check.
4. **Single-flight** (completion.ts:43): busy-wait loop polling `isRequestInProgress` every `DELAY_BEFORE_COMPL_REQUEST` (150 ms).
5. **Local context** (completion.ts:54–73): `Utils.getPrefixLines` (n_prefix=256 lines), `Utils.getSuffixLines` (n_suffix=64), current line split into `linePrefix`/`lineSuffix`; abort if `lineSuffix > max_line_suffix` (8 chars).
6. **Cache lookup** (completion.ts:78, `getCachedCompletion` completion.ts:170): sha256 of `prefix|suffix|prompt` in `LRUCache` (lru-cache.ts, 250 keys); also matches progressively shorter prompts whose cached completion prefix-matches what was typed since.
7. **Backend call** (completion.ts:90): `llamaServer.getFIMCompletion(inputPrefix, inputSuffix, prompt, extraContext.chunks, nindent)` — the single seam.
8. **Endpoint/model/auth resolution**: `getComplModelProperties` (llama-server.ts:1414) merges the selected `LlmModel` (env system) over `configuration.endpoint` / `axiosRequestConfigCompl`.
9. **Post-processing**: `getComplFromContent` (completion.ts:368, normalizes single vs `n_cmpl` multi-response), `shouldDiscardSuggestion` (completion.ts:211, repeats-existing-text heuristics), `updateSuggestion` (completion.ts:254, suffix trimming).
10. **Cache write + state** (completion.ts:123–124), then async fire-and-forget (completion.ts:127): statusbar update, **speculative prefetch** `cacheFutureSuggestion`/`cacheFutureAcceptLineSuggestion` (extra server round-trips for the post-accept cursor states), and `extraContext.addFimContextChunks`.
11. **Return** `vscode.InlineCompletionItem[]` via `getCompletion` (completion.ts:191) — VS Code renders ghost text natively.

Accept-partial commands (`insertNextWord`, `insertFirstLine` completion.ts:307/333) and suggestion cycling (`increaseSuggestionIndex`, wired in architect.ts:110 around `editor.action.inlineSuggest.showNext`) manipulate a shadow copy of state in `lastCompletion`.

## 3. Backend abstraction

**There is effectively none for completion.** `LlamaServer` (llama-server.ts, 1472 LOC) is a god class covering FIM, chat, chat-edit, agent/tools streaming, embeddings, tokenize, health checks, and terminal process management. `getFIMCompletion` hard-codes two paths behind a boolean:

- `use_openai_endpoint=true` → `handleOpenAICompletion` (llama-server.ts:139): OpenAI SDK `completions.create` with a configurable FIM prompt string `openai_prompt_template` (configuration.ts:64, section commented *"experimental - avoid using"*).
- default → axios `POST {endpoint}/infill` with a llama.cpp-proprietary payload (`createRequestPayload` llama-server.ts:183: `input_prefix/suffix/extra`, `n_indent`, `samplers:["top_k","top_p","infill"]`, `cache_prompt`, `t_max_prompt_ms/predict_ms`, `id_slot:0`).

The `IAddStrategy` implementations (`services/hf-model-strategy.ts`, `local-model-strategy.ts`, `external-model-strategy.ts`, `openai-comp-model-strategy.ts`) are **model-catalog setup wizards** (QuickPick UI for adding entries to `completion_models_list` etc.), *not* request adapters — despite the name, they don't abstract the wire protocol. The only genuine data abstraction is `LlmModel` (types.ts:39: name/aiModel/endpoint/isKeyRequired) and the partially-normalized `LlamaResponse` (types.ts:11).

**Adding a backend today = adding another if-branch inside `getFIMCompletion`.** Easy mechanically (one function), poor architecturally (no interface, no capability model, no tests around it).

## 4. Context building

- **Prefix/suffix**: line-based windows around the cursor (completion.ts:54–55).
- **Ring buffer of extra chunks** (`ExtraContext`, extra-context.ts): up to `ring_n_chunks=16` chunks of `ring_chunk_size=64` lines, gathered from (a) cursor vicinity on editor switch (architect.ts:86 `setOnChangeActiveFile`), (b) document save (extra-context.ts:155 `handleDocumentSave`), (c) copy/cut interception (architect.ts:322 `setClipboardEvents` → `addChunkFromSelection`), (d) distant cursor movement after a completion (extra-context.ts:47 `addFimContextChunks`). Deduped/evicted by Jaccard similarity > 0.9 (extra-context.ts:141). A 1 s timer (architect.ts:179) drains the queue one chunk at a time and **warms the server KV cache** via `updateExtraContext` → `/infill` with `n_predict:0` (llama-server.ts:1064) — llama.cpp-only.
- Chunks are sent as `input_extra` on `/infill`; the OpenAI path just prepends `"Context:\n" + chunks.join()` (llama-server.ts:149).
- **Not used for completion**: LSP, diagnostics, symbols, open-editor set, RAG. RAG/embeddings (`chat-context.ts`) serve only chat/agent.

## 5. Request lifecycle

- **Debounce**: `debounce_ms`, default 0 (completion.ts:34).
- **Cancellation**: VS Code `CancellationToken` checked at discrete points only; **no AbortController on the FIM axios call** — an in-flight request always runs to completion and blocks the next via the single-flight loop.
- **Streaming**: none for completion (`stream:false`); SSE streaming exists only for agent/tools (llama-server.ts:942).
- **Caching**: client LRU (250 entries) + prompt-prefix reuse + speculative prefetch; server-side `cache_prompt:true` + warm-up posts.
- **Retries**: none. **Timeout**: no client HTTP timeout; only llama.cpp server-side hints `t_max_prompt_ms=500` / `t_max_predict_ms=2500`.

## 6. Completion rendering

- `vscode.languages.registerInlineCompletionItemProvider({pattern:'**'}, …)` (architect.ts:308).
- Suggestions returned as `new vscode.InlineCompletionItem(text, new vscode.Range(position, position))` (completion.ts:196) — VS Code draws the ghost text; no decorations API involved.
- Multi-suggestion cycling reuses built-in `editor.action.inlineSuggest.showNext/showPrevious`, shadow-tracked by `complIndex` (architect.ts:110–138) — fragile duplicated state.
- Partial accepts are manual `editor.edit` insertions (completion.ts:307/333) bound to commands, not the native partial-accept API.
- Status feedback via `StatusBarItem` (statusbar.ts).

## 7. Separation of concerns (1–5)

| Concern | Score | Why |
|---|---|---|
| UI separation | 3 | Statusbar/menu/dialogs are separate classes, but `LlamaServer.getFIMCompletion` opens modal dialogs and webviews on missing endpoint (llama-server.ts:790–804) — transport layer doing UX. |
| Backend separation | 2 | All HTTP lives in one file, but as a 1472-LOC god class mixing 6 concerns; llama.cpp payloads inline; `Configuration` constructs the OpenAI SDK client (configuration.ts:447). |
| Completion separation | 3.5 | `Completion` is a coherent pipeline with a single backend seam, but reaches into `app.*` singletons (service locator) and its cache-key format is welded to prompt assembly. |
| Provider abstraction | 1.5 | A boolean + if-branch. `IAddStrategy` is naming-only abstraction (setup UX, not protocol). No capability detection, no per-model strategy. |

## 8. Modification effort: native FIM + instruct via /v1/completions

- **Files to modify**: `src/llama-server.ts` (extract/replace `getFIMCompletion`, `handleOpenAICompletion`, `updateExtraContext`), `src/configuration.ts` + `package.json` (settings/capability fields), `src/types.ts` (`LlmModel` capability flags), `src/completion.ts` (minor — response already normalized). ~4–5 files.
- **LOC**: ~300–600 new (backend interface + 2 adapters + strategy selection), ~100–150 modified. The experimental OpenAI path proves the template-FIM-over-`/v1/completions` shape already works end-to-end, so this is completing a half-built feature, not greenfield.
- **Risks**: (1) `input_extra` chunks and KV warm-up are llama.cpp-only — need graceful degradation; (2) cache key omits model/endpoint (completion.ts:78) — switching backends can serve stale results (latent bug today); (3) no client-side cancellation/timeout hurts more on slower instruct models; (4) `Application` singleton makes the seam hard to unit-test; (5) statusbar consumes llama.cpp-specific timing fields.

## 9. Overall assessment

**Extract-and-rewrite (port the engine, not the repo); contribute upstream only for targeted fixes.**

- The completion *algorithms* are genuinely good and battle-tested: speculative prefetch, prompt-prefix cache reuse, ring-buffer context with Jaccard eviction, KV-cache warm-up. That ~1,000 LOC core (completion.ts, extra-context.ts, lru-cache.ts, ~200 LOC of llama-server.ts) is worth porting, and it's MIT.
- But llama.vscode has grown into a chat/agent/RAG/tools/webview suite — >70 % of the code is out of scope for a "no chat, no agents, tiny footprint" tool, and upstream's roadmap points the other way. A fork means carrying webviews, translations, an agent runtime, and an installer flow you'd delete.
- Contributing a proper multi-backend completion abstraction upstream is feasible (it's one file's refactor) and would be a good citizen move, but it doesn't get FlashComplete its identity: minimal surface, model routing, backend capability negotiation.

---

# Phase 2 — Code map (completion subsystem only)

Legend: complexity = cyclomatic/LOC feel; coupling = to the rest of the app. ★ = likely extension point.

```
extension.ts — activation, wires Architect                      [trivial, low]
└── application.ts — service-locator singleton, owns all parts   [low cx, HIGH coupling (hub)]
    ├── architect.ts ★ (only: setCompletionProvider :307,
    │       registerCommandManualCompletion :244,
    │       registerCommandNoCacheCompletion :256,
    │       setPeriodicRingBufferUpdate :179,
    │       setOnSaveFile :199, setOnChangeActiveFile :86,
    │       setClipboardEvents :322,
    │       accept/cycle commands :110–167)
    │     responsibility: VS Code registration & event wiring    [low cx each, medium coupling]
    ├── completion.ts — pipeline: debounce, cache, call, filter,
    │       speculative prefetch, partial accepts                [HIGH cx, high coupling (app.*)]
    │     ★ getComplFromContent :368 (response normalization)
    │     ★ getCompletionItems :26 (the pipeline)
    ├── llama-server.ts — ALL backend I/O (god class)            [HIGH cx, high coupling]
    │     ★★ getFIMCompletion :774 — THE seam to replace
    │     ★ handleOpenAICompletion :139 — template-FIM prototype
    │     ★ createRequestPayload :183 — llama.cpp payload
    │     ★ updateExtraContext :1064 — KV warm-up (llama.cpp-only)
    │     getComplModelProperties :1414 — endpoint/key resolution
    ├── extra-context.ts — ring-buffer context engine            [medium cx, low coupling] ★ (portable)
    ├── lru-cache.ts — LRU + sha256 hashing                      [low cx, LOW coupling] (portable as-is)
    ├── configuration.ts — flat settings bag + OpenAI client     [low cx, medium coupling]
    │     ★ openai_prompt_template / use_openai_endpoint :60–64
    ├── utils.ts — getPrefixLines :36 / getSuffixLines :41 /
    │       removeTrailingNewLines :46 / delay :32               [trivial, low]
    ├── statusbar.ts — timing display (llama.cpp field names)    [low cx, medium coupling]
    ├── prompts.ts — replacePlaceholders :318 (template fill)    [trivial, low]
    └── types.ts — LlamaResponse :11, LlmModel :39               [trivial, low] ★ (add capability fields)

Peripheral (affects completion indirectly):
    services/model-service.ts + *-model-strategy.ts — model list setup UX,
        selection state, health checks                           [medium cx, medium coupling]
    menu.ts — enable/disable completion toggle                   [low]
    persistence.ts — API keys for endpoints                      [low]
```

**Not in the subsystem** (ignore per brief): chat-context.ts (RAG), llama-agent.ts, tools.ts, chat-with-ai.ts, llama-webview-provider.ts, llama-chat-model-provider.ts, ui/.

---

# Phase 3 — Refactoring opportunities (completion only)

Findings:

- **Unnecessary coupling**: `Completion` ↔ `Application` service locator (statusbar, logger, extraContext, cache all reached via `app.*`); `LlamaServer` opens dialogs/webviews (llama-server.ts:790); `Configuration` constructs an OpenAI SDK client; statusbar reads raw llama.cpp timing fields; suggestion-index shadow state split between architect.ts commands and completion.ts.
- **Duplicated logic**: four near-identical endpoint/key/requestConfig resolvers (`getComplModelProperties`, `getChatModelProperties` llama-server.ts:1384, `getToolsRequestDetails` :315, inline copy in `getEmbeddings` :1085); five copy-pasted `shell*Cmd`/`kill*Cmd` terminal pairs; prompt-assembly logic duplicated between the main path and `cacheFutureSuggestion` (completion.ts:263).
- **Provider-specific assumptions**: `/infill` route, `input_extra`, `n_indent`, `samplers:["…","infill"]`, `id_slot:0`, `cache_prompt`, `t_max_*` are llama.cpp-only; KV warm-up assumes the same server keeps state; `lora:[{id:0,scale:0.5}]` hard-coded scale; temperature 0.1 hard-coded in the OpenAI path.
- **Hard-coded APIs**: URLs assembled by string concat per call site; default endpoints carry a typo (`"http=//127.0.0.1:8012"` configuration.ts:20 — dead defaults, overwritten by settings, but telling); health check assumes llama.cpp `/health` shape (llama-server.ts:1455).
- **Architectural bottleneck**: everything below `getFIMCompletion` is one class; everything above assumes a single synchronous, non-streaming, non-cancellable request.

Ranked refactorings (effort → payoff):

| # | Refactoring | Effort | Payoff |
|---|---|---|---|
| 1 | Include model+endpoint in the LRU cache key (fix stale-completion-across-model-switch) | Low (~10 LOC, completion.ts:78) | High — correctness bug |
| 2 | Consolidate the 4 endpoint/key resolvers into `resolveModelProperties(ModelType)` | Low (~60 LOC) | Medium |
| 3 | Add AbortController + client timeout to FIM; replace `isRequestInProgress` polling with cancel-previous | Low–Med (~80 LOC) | High — latency & responsiveness |
| 4 | Extract `CompletionBackend` interface (`complete(ctx): NormalizedCompletion`, optional `warmContext(chunks)`) with `LlamaCppInfillBackend` + `OpenAICompletionsBackend`; select per `LlmModel` | Medium (~400 LOC) | **Highest** — unlocks everything in Phase 4 |
| 5 | Move dialogs out of `getFIMCompletion` (typed "no endpoint" result; UI reacts in Completion/menu layer) | Low | Medium |
| 6 | Inject narrow deps into `Completion` (cache, backend, config slice, status callback) instead of `Application` | Medium | High — testability (currently ~0 tests on completion) |
| 7 | Normalize timings/`LlamaResponse` so statusbar isn't llama.cpp-shaped | Low | Low–Med |
| 8 | Split `LlamaServer` into FimClient / ChatClient / AgentClient / EmbeddingsClient / ProcessManager | High | Medium (matters for repo health, not for completion alone) |

---

# Phase 4 — Fit against the FlashComplete design goals

**Which abstractions already exist?**
- The **UI-invariance requirement is already met**: strategy choice would live entirely below the `Completion → getFIMCompletion` seam; the pipeline, cache, ghost text, and commands never inspect the backend.
- `LlmModel` + env system: per-role model selection with endpoint/key, persisted, with a selection UI.
- A working proof of **template-FIM over `/v1/completions`** (`handleOpenAICompletion` + `openai_prompt_template`) — i.e., strategy #2 exists in embryo.
- Normalized-enough response type (`LlamaResponse`), LRU + speculative caching, ring-buffer context engine — all backend-neutral in principle.

**Which abstractions are missing?**
- A `CompletionBackend`/strategy interface and **capability detection** (does the endpoint serve `/infill`? does the model have FIM tokens? is only `/v1/chat/completions` available?) — nothing probes this today.
- Per-model **FIM template registry** (one global template string today; Qwen/CodeGemma/StarCoder/Codestral all differ), stop-token handling, and chat-prompt fallback with output sanitization (code-fence stripping, truncation at suffix) — none exist.
- Client-side cancellation/timeout/streaming (needed for the multi-model draft→verify idea).
- Ollama specifics (`/api/generate` with native `suffix` support, model metadata via `/api/show`) — Ollama works today only through its OpenAI-compat layer under the experimental flag.

**Which components would need redesign?**
- `llama-server.ts` completion portion (replace, per Phase 3 #4).
- `LlmModel`/configuration: add capability/strategy metadata per model.
- `ExtraContext` handoff: `input_extra` must render into prompt text for non-llama.cpp backends (the current `"Context:\n"+join` is a stub), and KV warm-up must become a backend-optional capability.
- Cache key (must include model identity).

**Could this be implemented as a plugin?** No — llama.vscode has no plugin/extension mechanism; it *is* the VS Code extension, and its backend seam is a private class. The realistic in-repo route is the Phase 3 #4 refactor contributed upstream. FlashComplete as a separate extension reusing ported code is the "plugin-like" option.

**Would a clean fork be easier?** A clean **new extension that ports the ~1,000-LOC completion core** (completion.ts, extra-context.ts, lru-cache.ts, the prefix/suffix utils, statusbar idea) and writes a fresh ~800-LOC backend layer (llama.cpp `/infill`, Ollama native, OpenAI-compatible, chat fallback, capability probe) is easier than forking: a fork inherits the agent runtime, webview UI, RAG, installer flows, and translations that FlashComplete explicitly excludes, plus the `Application` singleton that resists trimming. MIT license permits the port with attribution. Rough scope for an MVP: ~2–2.5k LOC total — consistent with "tiny footprint".

**Bottom line**: llama.vscode validates every mechanism FlashComplete needs and supplies a portable, proven completion core, but its trajectory (full agent suite) and its 1.5/5 provider abstraction argue for extraction into a purpose-built extension rather than fork or upstream-first.

## Verification

This is an analysis deliverable — no code changes. Verification = spot-checking the cited files/lines (all citations were read directly during this session: completion.ts, llama-server.ts, extra-context.ts, architect.ts, application.ts, configuration.ts, lru-cache.ts, types.ts, statusbar.ts, extension.ts).
