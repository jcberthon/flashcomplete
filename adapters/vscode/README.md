# FlashComplete

Local-first, ultra-fast inline code completion for VS Code, talking to a
llama.cpp server **you** run yourself. No cloud, no chat, no agents — just
ghost-text completions from a local model.

> v0.9 supports llama.cpp's native `/infill` endpoint. Ollama and
> OpenAI-compatible backends arrive in v1.0, chat-fallback in v1.1.

## Quick start

1. Start a llama.cpp server with a FIM-capable model (Qwen2.5-Coder, StarCoder2,
   CodeGemma, Codestral, …):

   ```sh
   llama-server -m Qwen2.5-Coder-1.5B-Q8_0.gguf --port 8012
   ```

2. Install the extension and set `flashcomplete.endpoint` if your server is not
   on the default `http://127.0.0.1:8012`.

3. Type. Ghost text appears; `Tab` accepts it.

## Keys & commands

| Action | Default key | Command |
|---|---|---|
| Accept suggestion | `Tab` (VS Code native) | — |
| Accept first line | `Shift+Tab` | `flashcomplete.acceptFirstLine` |
| Accept next word | `Ctrl+Alt+Right` | `flashcomplete.acceptNextWord` |
| Trigger manually | `Alt+\` | `flashcomplete.triggerCompletion` |
| Trigger, bypassing the cache | — | `flashcomplete.triggerNoCache` |
| Enable/disable | statusbar click | `flashcomplete.toggle` |

## How it stays fast

- **Client LRU cache** with prompt-prefix reuse — typing along with a suggestion
  costs zero server round-trips.
- **Speculative prefetch** — after showing a suggestion, the engine pre-requests
  the completion you'd need after accepting it.
- **Ring-buffer context** — nearby code chunks are collected in the background
  and sent as extra context; on llama.cpp the server's KV cache is pre-warmed
  with them.
- **Cancel-on-keystroke** — a new keystroke aborts the in-flight HTTP request;
  no queueing behind stale requests.

## Credits

The completion pipeline is in part ported from
[llama.vscode](https://github.com/ggml-org/llama.vscode) (MIT License,
© llama.vscode contributors). See the project's `ATTRIBUTIONS.md` for details.

## License

MIT
