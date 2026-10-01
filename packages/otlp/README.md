# `@balsa/otlp`

The OTLP exporter for [Balsa](https://github.com/0xnicholas/balsa-framework): one
`createOtlpExporter()` that maps the kernel's own spans to **GenAI semconv-shaped OTLP** over HTTP
(protobuf or JSON). Langfuse, LangSmith and any OTel backend that ingests naked OTLP +
`gen_ai.*` receive the standard shape directly — there is no vendor-specific exporter.

```ts
import { createApp } from '@balsa/core';
import { createTracer } from '@balsa/core/observability';
import { createOtlpExporter } from '@balsa/otlp';

const tracer = createTracer({ exporters: [createOtlpExporter()] });
const app = createApp({ tracer });

// … run agents; spans ship on the batch schedule …
await tracer.flush();
await tracer.shutdown();
```

- Spec: [`docs/architecture/observability.md`](https://github.com/0xnicholas/balsa-framework/blob/main/docs/architecture/observability.md) —「OTLP 能力包(M5 设计冻结)」
- Wire facts this package builds on: [`docs/research/otlp-js-packages.md`](https://github.com/0xnicholas/balsa-framework/blob/main/docs/research/otlp-js-packages.md)
- Decisions: [ADR-0009](https://github.com/0xnicholas/balsa-framework/blob/main/docs/adr/0009-observability-tracing.md) (observability), [ADR-0002](https://github.com/0xnicholas/balsa-framework/blob/main/docs/adr/0002-package-structure.md) (packaging)
- Example: [`examples/otlp-collector`](https://github.com/0xnicholas/balsa-framework/blob/main/examples/otlp-collector) — a traced agent run lands in a local OTLP collector

## Install

```bash
npm install @balsa/otlp @balsa/core
```

`@balsa/core` is a peer dependency (one core instance by design). The package brings the official
OpenTelemetry exporter stack (`exporter-trace-otlp-proto` / `-http`, `sdk-trace`, `resources`,
`api` — five pinned dependencies; `semantic-conventions` rides the tree transitively but is never
imported — `gen_ai.*` keys are written as string literals, so semconv drift changes this package,
never the core).

## Options

```ts
createOtlpExporter({
  protocol: 'protobuf' | 'json',      // default 'protobuf'
  url, headers, timeoutMillis, compression,
  serviceName, resourceAttributes,
  batch: { maxExportBatchSize, scheduledDelayMillis, maxQueueSize, exportTimeoutMillis },
});
```

- **Priority is explicit option > env > official default.** Unset options pass through to the
  official exporter base, which resolves `OTEL_EXPORTER_OTLP_{ENDPOINT,HEADERS,TIMEOUT,COMPRESSION,…}`
  plus the `…_TRACES_*` specializations itself (headers merge, specialized wins; a common endpoint
  gets `/v1/traces` appended). The default endpoint is `http://localhost:4318/v1/traces`.
- **`protocol` is this package's own env face**: `OTEL_EXPORTER_OTLP_PROTOCOL=json` selects the
  JSON exporter — the official packages do not read that variable (protocol = which package you
  load). Unsupported values warn on OTel diag and fall back to protobuf.
- **Resource**: `service.name` defaults to `balsa`, overridden by env (`OTEL_SERVICE_NAME` /
  `OTEL_RESOURCE_ATTRIBUTES`), then by `serviceName`, then by `resourceAttributes` (which wholly
  overrides `serviceName`). No `telemetry.sdk.*` is emitted — this package does not run the OTel
  SDK and does not claim it.

## What lands on the wire

Only `span_ended` enters OTLP (the kernel's started/updated events are dropped — OTLP spans are
immutable). Every span is rebuilt per the seven-type mapping contract: names from templates
(`invoke_agent {agentName}`, `chat {model}`, `execute_tool {toolName}`, `invoke_workflow
{workflowId}`, `workflow-step {stepId}`, `memory-recall/-save {threadId}`), `gen_ai.operation.name`
where semconv defines one, `balsa.span.type` / `balsa.run_id` / `balsa.thread_id` for Balsa-side
correlation, prompts and outputs as semconv message parts, model params through the documented
whitelist, usage on `chat` spans only. Open span types pass their names through untouched.
`isEvent` spans become zero-duration spans.

The failure face is the official stack's: `export()` only enqueues and never throws (a full queue
drops silently, background export failures are silent — diagnostics ride OTel diag); `flush()` /
`shutdown()` pass through to the batch processor, so an explicit `flush()` on a dead endpoint
rejects with the official transport error.
