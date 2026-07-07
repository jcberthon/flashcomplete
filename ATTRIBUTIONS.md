# Attributions

FlashComplete's completion pipeline is in part **ported from
[llama.vscode](https://github.com/ggml-org/llama.vscode)** (MIT License,
Copyright © 2025 The llama.vscode contributors). The port was deliberate and
selective: algorithms were carried over, the architecture around them was
redesigned (see [docs/ARCHITECTURE-REVIEW.md](docs/ARCHITECTURE-REVIEW.md)).
A frozen reference copy of the upstream source lives under
`reference/llama-vscode/` (git-ignored; update only by re-copying from upstream).

## Ported code inventory

| FlashComplete file | Upstream source | What was ported / changed |
|---|---|---|
| `core/src/cache.ts` | `lru-cache.ts`; `completion.ts` (`getCachedCompletion`) | LRU cache and sha256 keying ported nearly as-is; prompt-prefix reuse ported. **Changed:** the cache key now includes the backend + server/model identity (fixes the stale-completion-across-model-switch bug). |
| `core/src/context.ts` | `utils.ts` (`getPrefixLines`, `getSuffixLines`); `completion.ts` (local-context assembly); `extra-context.ts` (ring buffer, Jaccard eviction, chunk picking) | Ported with the VS Code document API replaced by a plain `DocumentSnapshot`; tuned constants (chunk sizes, distances, timings) carried over verbatim. |
| `core/src/postprocess.ts` | `completion.ts` (`shouldDiscardSuggestion`, `updateSuggestion`, `removeTrailingNewLines`, leading-space helpers) | Heuristics ported line-for-line onto `DocumentSnapshot`. **Changed:** fixed an operator-precedence bug in the leading-whitespace stripper (tabs were stripped beyond the requested count). |
| `core/src/engine.ts` | `completion.ts` (`getCompletionItems` pipeline, `cacheFutureSuggestion`, `cacheFutureAcceptLineSuggestion`) | Pipeline order and speculative-prefetch algorithms ported. **Changed:** busy-wait single-flight replaced by cancel-previous `AbortController`; explicit dependency injection instead of the `Application` service locator; typed error outcomes instead of in-transport dialogs. |
| `core/src/backends/llamacpp.ts` | `llama-server.ts` (`createRequestPayload`, `getFIMCompletion`, `updateExtraContext`) | `/infill` request payload and KV-cache warm-up (`n_predict: 0`) ported. **Changed:** axios replaced by `fetch` with `AbortSignal` + client-side timeout; UI dialogs removed; hard-coded `lora` scale dropped; llama.cpp timing fields normalized before leaving the backend. |

Everything else (`core/src/types.ts`, `backend.ts`, `errors.ts`, the whole
`adapters/vscode/` extension) is original FlashComplete code, written for this
project.

## License compliance

- FlashComplete is MIT-licensed, the same license as llama.vscode.
- The upstream copyright and permission notice is retained in [LICENSE](LICENSE).
- Every file containing ported code carries a header pointing back to
  llama.vscode and to this inventory.
- The project README credits llama.vscode as the origin of the validated
  completion-pipeline design.
