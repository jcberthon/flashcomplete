# FlashComplete

A local-first, model-agnostic, ultra-fast inline completion engine for VS Code
(and, over time, other IDEs).

- Works with llama.cpp
- Works with Ollama
- Works with any OpenAI-compatible server
- Native FIM when the model/server supports it
- Intelligent fallback otherwise (completion endpoint, then chat prompt)
- Zero cloud
- No chat
- No agents
- Tiny footprint

Not a competitor to Copilot Chat. Not a competitor to Continue. Just a modern
autocomplete engine, equally comfortable talking to FIM and instruct models,
using LSP where it helps, exploiting KV-cache reuse where the backend supports
it, and — optionally — chaining multiple models together depending on what
hardware is actually available.

## Why

Models are moving faster than editor extensions. Small models like LFM 2.5 don't
fit the categories "chat model" or "FIM model" that shaped tooling two years ago
— they're fast enough to feel instantaneous but general enough to need a
fallback strategy. The missing piece is an abstraction layer between the editor
and local backends that picks the right completion strategy per model, without
the editor-facing UX ever changing.

## How it works

```
                     VS Code (or other IDE)
                              │
                              ▼
                    FlashComplete engine
                              │
             ┌────────────────┴────────────────┐
             │                                  │
             ▼                                  ▼
        Fast draft                      Direct completion
     (small, fast model)               (native FIM model)
             │
             ▼
     Confidence estimation
             │
        ┌────┴────┐
        │         │
      High      Low
        │         │
        ▼         ▼
     Return   Verify / refine
              (larger model)
```

The big model doesn't get called by default — only when the draft is
uncertain. A draft ending in `push_back(` is unambiguous; one ending in
`assign(` or `emplace_back(` is worth a second opinion. Gating the expensive
model behind a confidence check, rather than always chaining, is what keeps
this fast on modest hardware.

## Scales down and up

| Setup | Strategy |
|---|---|
| Laptop, 16 GB | small fast model alone (e.g. an LFM-class model) — a few misses, but smooth and cheap |
| Typical dev machine, 32 GB | small model for perceived latency, escalate to a mid-size model (e.g. Gemma-class 12B) when unsure |
| Workstation, 64 GB+ | small model → strong coder model (e.g. Qwen3-Coder 30B) → optional large reasoning model as a last resort |

Model choices above are illustrative, not hard-coded — any backend implementing
the `CompletionBackend` interface (see [AGENTS.md](AGENTS.md)) can slot into any
tier.

## Status

**v0.9** — the first working release. The engine (`core/`) and the VS Code
adapter (`adapters/vscode/`) are built and unit-tested; the llama.cpp `/infill`
backend is the one shipping backend. You launch the server yourself:

```sh
llama-server -m Qwen2.5-Coder-1.5B-Q8_0.gguf --port 8012
```

then install the extension (`npm install && npm run package` →
`flashcomplete-0.9.0.vsix`) and set `flashcomplete.endpoint` if you changed the
port. `npm run verify` runs the full quality gate (format, lint with the
core-purity rule, strict typecheck, unit tests).

Roadmap: **v1.0** adds Ollama-native and OpenAI-compatible backends plus a VS
Code integration-test harness; **v1.1** adds the chat-completion fallback;
the draft→verify multi-model chaining above is v2 territory. Deferred ideas
live in [docs/FUTURE_WORK.md](docs/FUTURE_WORK.md).

The design was validated by an architectural review of
[llama.vscode](https://github.com/ggml-org/llama.vscode), whose completion
pipeline (debounce, LRU/speculative caching, ring-buffer context, KV-cache
warm-up) is sound and partly reused here. See
[docs/ARCHITECTURE-REVIEW.md](docs/ARCHITECTURE-REVIEW.md) for the full
analysis, [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the ported-code inventory, and
the reference source under `reference/llama-vscode/`.

## Credits

Completion-pipeline algorithms in this project were validated against, and in
part ported from, [llama.vscode](https://github.com/ggml-org/llama.vscode)
(MIT License, © llama.vscode contributors).

## License

MIT
