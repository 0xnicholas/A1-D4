# otlp-collector

A traced agent run lands in a local OTLP collector as GenAI semantic-convention spans: a `node:http`
collector plays the backend (Langfuse, LangSmith and any OTel collector speak the same wire), a scripted
model drives a real agent run, and [`@balsa/otlp`](../../packages/otlp/) ships the run's spans over OTLP.
Balsa is an ultralight TypeScript agent framework — compose only what you use, run anywhere, no runtime
baggage.

One script (`src/index.ts`), no API key and no network beyond loopback. Two acts:

1. **The run is traced and shipped** — `createApp({ tracer })` distributes the tracer; the framework's own
   span model never leaves the process. The collector receives `invoke_agent refund-desk` →
   `chat scripted-mini` (CLIENT kind, `gen_ai.*` request / usage / response attributes, messages as parts)
   → `execute_tool checkOrder` (arguments / result), plus `balsa.span.type` and `balsa.run_id` for
   Balsa-side correlation. The tree keeps trace context: run → step → tool, one trace id.
2. **The failure face** — with the collector unreachable the run still completes: `export()` never throws.
   Only an explicit `flush()` surfaces the transport failure, straight from the official exporter stack.

## Run

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter @balsa/example-otlp-collector start
```

The exporter target defaults to this script's local collector. The official env surface passes straight
through to point it at a real backend instead:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example:4318 \
  pnpm --filter @balsa/example-otlp-collector start
```

OTLP/JSON is the default here so the local collector can decode what it receives; set
`OTEL_EXPORTER_OTLP_PROTOCOL=protobuf` to switch the wire (the collector then reports opaque bytes, the way
a real backend accepts them). The script self-asserts (`node:assert/strict`): a span tree that is missing
or misparented, a `gen_ai.*` attribute that drifts — each exits non-zero instead of printing a happy face.

## Notes

- The **scripted model is defined in the file** — the example runs with no key and no network.
- The example consumes `@balsa/core` and `@balsa/otlp` through their built package exports — run
  `pnpm build` before `start`. Package docs: [`packages/otlp`](../../packages/otlp/); spec:
  [`docs/architecture/observability.md`](../../docs/architecture/observability.md) 「OTLP 能力包」.
