# minimal-agent

The smallest runnable Balsa example. Balsa is an ultralight TypeScript agent framework — compose
only what you use, run anywhere, no runtime baggage.

This example defines a five-field agent (`name` / `instructions` / `model`) and runs one
`stream()` round-trip. The output object supports both consumption styles: `for await` yields the
core's own chunk protocol (here: each `text-delta` is rendered as it arrives), and the terminal
values (`finishReason` / `usage`) are awaited on the same object. The model instance comes
straight from an AI SDK provider package (`@ai-sdk/openai`) — no adapter, no registry (ADR-0004).
Instructions become the system message, the input becomes the user message.

`generate()` is the same run collapsed to its terminal value — literally `stream()` + await the
terminal values, one code path, so the two always agree.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume @balsa/core through its package exports (dist)
OPENAI_API_KEY=sk-... pnpm --filter @balsa/example-minimal-agent start
```

Switch to an OpenAI-compatible endpoint the same way — the core has no special mechanism, install
the matching provider package:

```bash
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
  pnpm --filter @balsa/example-minimal-agent start
```

Expected output: the model's text streamed as it arrives, then a `finishReason` and `usage`
summary.

## Notes

- The example uses `openai.chat(...)` (Chat Completions), the lowest common denominator across
  OpenAI and OpenAI-compatible endpoints. Use `openai('gpt-4o-mini')` for OpenAI's Responses API.
- The run starts on first consumption (the first `for await` step or the first terminal promise).
- Leaving the `for await` loop early does not cancel the run; pass a per-call `signal` to cancel.
- Tools and observability instrumentation land with the remaining M1 tickets — see
  `docs/ROADMAP.md`.
