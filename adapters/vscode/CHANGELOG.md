# Changelog

## 0.9.0

First release.

- Inline completions (ghost text) against a manually launched llama.cpp server
  (`/infill` endpoint), automatic and manual triggering
- Client-side LRU completion cache with prompt-prefix reuse and speculative
  prefetch of post-accept states
- Ring-buffer context gathering (file save, editor switch, cursor movement)
  with llama.cpp KV-cache warm-up
- Client-side request cancellation (newest keystroke wins) and hard timeout
- Accept full suggestion / first line / next word; enable-disable toggle;
  bypass-cache retrigger
- Statusbar with backend-neutral timing display
- Typed error classification: configuration problems get one actionable
  message, transient failures stay in the statusbar
