# Integration

Patent Research Hub can be used three ways: as an MCP server, as a CLI, and as an importable Node module. This
page covers the module contracts other tools rely on and the optional integrations the Hub can use.

## MCP and CLI

See the README for the MCP registration snippet. Every MCP tool has a CLI equivalent in `src/cli.mjs` (run it with
no arguments for the list). Both return JSON and make no model call. A tool whose provider is not configured returns
a `not_configured` object (MCP: a normal result; CLI: exit code 2) naming the missing variables and the signup link.

## Stable gateway module (`src/gateway.mjs`)

Other tools can reuse the Hub's provider access without running the MCP server. The module exports:

| Export | Contract |
| --- | --- |
| `readConfig({env})` | Merged configuration: defaults, then `config.json` (or `PATENT_RESEARCH_CONFIG`), then environment overrides. Never contains credentials. |
| `callGateway(route, body, {config, env, fetchImpl, maxBytes})` | Calls one route and returns its envelope. Source routes return `{text, status, contentType}` and **return** a non-2xx `status` instead of throwing, so a caller can react to `413`/`429`. |
| `gatewaySource(source, url, options, config)` | Source call for a Hub source id; returns `{text, status, contentType}` and throws on a non-2xx status. |
| `gatewayAuth(config)` | n8n transport only: reads the local gateway bearer file. |

Routes on the direct transport: `uspto` (body `{source:'odp', url, method:'POST', body:{q, pagination:{offset, limit}}}`),
`ptab`, `govinfo`, `courtlistener`, `epo`, `public`, `reference-index`, `ptab-files`, `application-documents`,
`application-pdf`, `google-bigquery`, `google-bigquery-query`, `examiner-bigquery`, `examiner-bigquery-query`. The
`model`, `external-access`, `patentsview-catalog` and `oa-rejections` routes exist only on the n8n transport.
Every route validates its input with the same rules as the n8n workflows (`src/workflow-validation.mjs`), so a
caller cannot reach an arbitrary host, path or SQL text.

`config.transport` decides where a call goes: `direct` (default) uses the caller's environment variables
(`USPTO_API_KEY` and so on); `n8n` posts to the loopback n8n gateway described in
[extras/n8n/README.md](../extras/n8n/README.md). The envelope shape is the same on both.

### Patent Genius

The separate Patent Genius tool uses this module as an optional provider. Point it at the Hub with:

```sh
FRAME_GATEWAY_MODULE=/absolute/path/to/patent-research-hub/src/gateway.mjs
```

Patent Genius imports `callGateway` and `readConfig` and calls the `uspto` route with ODP search bodies. The Hub then
needs `USPTO_API_KEY` in Patent Genius's environment (direct transport) or a configured n8n gateway. This contract —
the two exports, the `uspto` route body and the `{text, status, contentType}` envelope with a returned status — is
kept stable across 0.1.x and is covered by `test/direct.test.mjs`.

## Provider quotas

The Hub's direct transport applies two local safeguards per provider: a minimum spacing between requests
(`directMinIntervalMs`) and a request-count cap per rolling hour (`maxRequestsPerHour`, default 120 for USPTO, EPO,
GovInfo, CourtListener and BigQuery; `0` disables it). Exceeding the cap raises a clear error naming the provider. These
limits are per process and are not your provider's quota: USPTO sets per-key limits, EPO OPS has a weekly fair-use quota,
and api.data.gov keys (GovInfo) default to about 1,000 requests per hour. Check each provider's current terms
(`research_sources` / `doctor` print the registration and terms links).

## Optional Get Files integration

Archiving originals into a searchable corpus, reading archived text (`research_archive`, `research_jobs`,
`research_passages`, `research_read_source`) and reference full-text indexing (`research_reference_acquire`,
`research_reference_poll`, `research_reference_search`) use the separate **Get Files** tool. Without it those tools
return `not_configured`; everything else works.

1. Install and start Get Files (its own README).
2. Set `RESEARCH_GET_FILES_CLIENT` (or `getFilesClientModule` in `config.json`) to its
   `integrations/get-files-client.mjs`. The module must export a `GetFilesClient` class. The Hub imports and runs it with your
   user rights, so treat this setting as trusted configuration (see [SECURITY.md](../SECURITY.md)).
3. For PTAB originals, the Hub stages the verified PDF under `corpusIntakeRoot` (default `<dataDir>/intake`) and
   asks Get Files to ingest that path. If your Get Files installation restricts local ingestion to its own intake
   folder, set `corpusIntakeRoot` to that folder.

PatentsView intake (an administrative CLI step) similarly uses `RESEARCH_CORPUS_CLIENT` (or `corpusClientModule`),
which must export a `CorpusClient` class, for example Get Files' `integrations/client.mjs`.

The Hub and Get Files have been used together on the developers' machine, but this public pairing has not been
re-verified end to end.

## Hermes and other agent frameworks

Earlier versions were developed alongside a Hermes Agent workbench. Hermes is not required. Any agent framework
that speaks MCP over stdio can register `src/mcp.mjs`; give it the skill text in `skills/patent-research/SKILL.md`
if it supports skills. Use `research_checkpoint` / `research_resume` for handoffs between clients; checkpoints are
plain JSON files in `<dataDir>/checkpoints` and contain no credentials.

The n8n transport also includes a loopback OpenAI-compatible model proxy (`src/model-proxy.mjs`, n8n `model`
route) that such a framework can use; it is optional and not part of the direct transport.

## n8n

n8n callers can use the portable workflows in `extras/n8n/workflows` (Execute Sub-workflow with the `*-core`
workflows, or the authenticated webhook gateways). See [extras/n8n/README.md](../extras/n8n/README.md).
