# Future Work

Deferred items, in rough order of expected value. Planned releases are tracked
in the README roadmap (v1.0: Ollama native + OpenAI-compatible backends,
integration-test harness; v1.1: chat fallback + strategy router). Everything
below is **after v1.1** and intentionally unscheduled.

## Draft → verify multi-model chaining (candidate v2 headline)

The README's core vision: a small fast model drafts, a confidence estimate
gates escalation to a stronger model. Needs streaming and per-request
multi-backend support in the engine; the `CompletionBackend` seam was designed
with this in mind.

## Backend/model identity probing

v0.9 keys the completion cache on backend + endpoint. If a user restarts the
same endpoint with a different model, stale completions are theoretically
possible until settings change. Probe llama.cpp `/props` (and Ollama
`/api/show`) to fold the loaded model into `CompletionBackend.identity()`.

## Server process management & model download wizards

llama.vscode launches/kills `llama-server` and offers HuggingFace model
catalogs. FlashComplete deliberately requires a user-launched server; revisit
only if demand is real.

## LSP / diagnostics / symbol context

The ring buffer is purely text-based today. LSP-derived context (types under
the cursor, signatures of called functions) is the most promising quality lever
that costs no extra model latency.

## Multi-suggestion generation (`n_cmpl`) and cycling

Upstream generates several parallel completions and cycles them with shadowed
index state (flagged fragile in the review). The engine already handles
`contents[]`; the missing pieces are the request knob and adapter UX.

## Clipboard copy/cut context feed

Upstream intercepts copy/cut to seed the ring buffer. Invasive (rebinds
clipboard commands); deferred until the value is proven.

## Automatic retries

Error *classification* exists (transient vs config vs timeout). A retry policy
(retry 5xx/network once, never retry 4xx/context-too-long) per
REFACTORING_PROPOSAL.md R6 would bolt onto the backend layer.

## Secret storage for API keys

`flashcomplete.apiKey` is a plain setting (upstream parity). VS Code
`SecretStorage` would be more appropriate once remote endpoints are common.
