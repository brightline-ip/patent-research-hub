# Integration

Patent Research Hub can be used three ways: as an MCP server, as a CLI, and as an importable Node module. This
page covers the module contracts other tools rely on and the optional integrations the Hub can use.

## MCP and CLI

See the README for the MCP registration snippet. Almost every MCP tool has a CLI equivalent in `src/cli.mjs` (run it
with no arguments for the list). Four MCP tools have none: `research_report`, `research_checkpoint`,
`research_resume` and `research_reference_pin`. The CLI also has administrative commands that are deliberately not MCP
tools (for example `bigquery-reconcile` and the PatentsView preparation and intake commands). Both return JSON and make
no model call. A tool whose provider is not configured returns
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
`application-pdf`, `oa-rejections`, `google-bigquery`, `google-bigquery-query`, `examiner-bigquery`,
`examiner-bigquery-query`. The `model`, `external-access` and `patentsview-catalog` routes exist only on the n8n transport.
`oa-rejections` (new in 0.2.0) is available on both transports.
Every route validates its input with the same rules as the n8n workflows (`src/workflow-validation.mjs`), so a
caller cannot reach an arbitrary host, path or SQL text.

`config.transport` decides where a call goes: `direct` (default) uses the caller's environment variables
(`USPTO_API_KEY` and so on); `n8n` posts to the loopback n8n gateway described in
[extras/n8n/README.md](../extras/n8n/README.md). The envelope shape is the same on both.

### Gateway command: the supported way for other tools

A tool that needs provider access should not import the Hub's modules or load `keys.env`. Start the Hub as a short-lived child:

```
"<install>\Hub.cmd" gateway <route> --json-in        (Windows installer: loads keys.env for this child only)
node src/cli.mjs gateway <route> --json-in           (from source: keys from your environment or node --env-file)
```

- **stdin:** one JSON object, at most 256 KB: the route body, exactly what `callGateway(route, body)` takes (for the `uspto`
  route `{source:'odp', url, method:'POST', body:{q, pagination:{offset, limit}}}`; for `oa-rejections`
  `{action:'records', application_numbers:['17000001', ...up to 100 eight-digit numbers], start?, rows?}` or `{action:'fields'}`).
- **stdout, exit 0:** the provider envelope `callGateway` returns, as one JSON document, for example
  `{"text":"...","status":200,"contentType":"application/json"}`. A provider status such as 404, 413 or 429 is **returned in the
  envelope** (a 429 adds `retryAfterSeconds`); it is not a failure of the command. The caller decides what to do with it.
- **stdout, any other exit:** `{"error":{"code":"...","message":"..."}}`. Exit 1 `error`; **2** `not_configured` (the key is
  missing; `missing`, `register` and `terms` are included, nothing was sent); **64** `bad_request` (usage, invalid JSON, not an
  object, over 256 KB); **75** `local_limit` (hourly cap used up) or `local_busy` (the key stayed busy or cooling down longer than
  `limiterMaxWaitMs`), both with `retry_after_seconds`, so the caller should wait and then retry.
- **Routes:** `uspto`, `ptab`, `oa-rejections`, `ptab-files`, `application-documents`, `application-pdf`, `govinfo`,
  `courtlistener`, `epo`, `public`, `reference-index`. BigQuery routes are not offered (they can cost money and have their own
  CLI commands and caps); neither are the n8n-only routes.
- **Effective limits.** `Hub.cmd gateway --limits` (no route, no stdin) prints JSON and exits 0: `hub_version`, `transport`, `limiter_applies`, per provider `max_calls_per_hour` (0 = unlimited; it counts calls, not HTTP attempts), `min_interval_ms` and `concurrent_calls_per_key` (1), plus `limiter_dir`, `limiter_max_wait_ms`, `limiter_stale_lock_ms` and `min_wait_after_429_seconds` (5). It reads configuration only: no key is read, no request is made, nothing is written. A caller can use it for time estimates (a dry run should divide by the lower of the cap and 3600000 / `min_interval_ms`; the values come from the same function the Hub enforces with, and an invalid setting is an error). An older Hub rejects `--limits` like any unknown usage (non-zero exit, no `error` object).
- **Starting it from your program.** `Hub.cmd` is a batch file, so start it through `cmd.exe`, with the whole command line in
  one quoted string (this is what the tests do, in a path containing a space):
  `spawn('cmd.exe',['/d','/s','/c','""'+hubCmdPath+'" gateway uspto --json-in"'],{windowsVerbatimArguments:true})`. Node's own
  quoting does not survive `cmd.exe`, and spawning a `.cmd` directly is refused by current Node versions. Write the request to
  the child's stdin and close it.
- **Large answers.** `application-pdf` returns the document as base64 inside the JSON, up to about 53 MB (a 40 MB PDF). Read
  stdout as a stream into a buffer of that size; a default `execFile`/`exec` limit (about 1 MB) will cut the answer off.
- **Stopping it.** Killing `Hub.cmd` (`cmd.exe`) does not by itself kill its `node` child; kill the process tree (`taskkill /T /F
  /PID <pid>`). As a safety net the node child checks every 2 seconds that the process that started it still exists and exits
  if not. It watches only its direct parent: if your program dies while `cmd.exe` stays alive, the child runs to the end of its
  call (bounded by the timeouts and `limiterMaxWaitMs`), releases its lock and exits.
- **Waiting.** The command takes its turn behind other Hub processes using the same key (see "Provider quotas"), so a call can
  take longer than the provider's own response time. Set your own timeout above `limiterMaxWaitMs` plus the download time, or
  lower `limiterMaxWaitMs` in `config.json`.
- **Nothing is retained.** The command does not write to the Hub database; it only touches the limiter state in
  the per-user limiter folder. The caller stores whatever it wants to keep.
- **No override.** The command never loads a module named by the environment or the request; `FRAME_GATEWAY_MODULE`-style
  test overrides belong to the caller and must be disabled in the caller whenever keys are loaded. Keys exist only in the
  child's environment.
- **Version check.** `gateway` exists from 0.2.0. An older Hub rejects the unknown option and exits non-zero without the
  JSON error shape above, so a caller should treat a non-zero exit with no `error` object as "Hub too old".

### Office-action rejections and the legacy API

`oa-rejections` posts to `https://api.uspto.gov/api/v1/patent/oa/oa_rejections/v2/records` (and `GET .../fields`), with the
key in `X-API-KEY`. Only 8-digit application numbers are accepted; the criteria are built by the Hub. The HTTP status comes from
the response. A 2xx answer must contain `response.numFound` (a non-negative integer) and `response.docs` (an array), or, for
the field list, `fields`; anything else, including a 2xx body that carries an error code, becomes 502, never zero records.
A 404 is passed through as 404 (only the ODP application search treats "no matching records" as a zero-count result). An empty result is expected to be a normal 200-shaped body with `numFound: 0`: the n8n route returned exactly that for an application with no office actions in a live probe, but that is inferred and not proven for the direct route.

The USPTO labels this API **legacy**. The route sits behind an adapter (`src/oa-adapter.mjs`, selected by the
`oaRejectionsAdapter` setting). The newer Office Action Search API is not implemented: its endpoint and field list could not be
read without signing in to the Open Data Portal when this release was prepared (the portal serves non-browser clients a script
shell, and the legacy documentation links lead to it), so whether it carries the rejection fields (`hasRej101` to `hasRejDP`,
`legalSectionCode`, `actionTypeCategory`, citation counts) is unverified. Adding it needs its documented contract and a test
written against that contract.

### Imports versus the gateway command

Prefer the `gateway` command for every keyed call. A program that imports `gateway.mjs`, `direct.mjs` or `hub.mjs` runs the same
limiter (one per-user folder, so it takes turns with `Hub.cmd`), but it holds your keys in its own memory, must load `keys.env` itself,
and must be configured with the same settings (`config.json`, `PATENT_RESEARCH_CONFIG`, `PATENT_RESEARCH_LIMITER_DIR`) as the Hub, or
it can apply different limits. The `gateway` command has none of these problems.

### Patent Genius

Patent Genius is a separate Brightline IP tool. From Hub 0.2.0 the supported route for provider calls is the
`gateway` command above: Patent Genius starts it as a child and never loads `keys.env` or imports Hub internals for
those calls. The older, import-based way below still works with this Hub but gives the importing process your keys in
memory; it is kept for the pieces that have no `gateway` equivalent yet. Patent Genius's `PG_HUB_ROOT` setting (alias
`PG_TOOL_HUB_ROOT`) names the Hub's install directory, and the import-based way loads modules from that directory's `src/`
folder with your user rights:

- `src/gateway.mjs`: `callGateway` and `readConfig`, to harvest USPTO search pages with ODP search bodies on the
  `uspto` route (its frame scripts). Its `FRAME_GATEWAY_MODULE` setting can point at a replacement gateway module instead.
- `src/patent-documents.mjs`: `patentDocumentInventory` and `acquirePatentDocumentOriginal`, to list and download
  file-wrapper documents.
- `src/hub.mjs`: the `Hub` class (`query`, `store.search`, `corpusSearch`) for live and local searches.
- `src/release.mjs`: `releaseStatus`.

Provider keys stay in the Hub's environment (`USPTO_API_KEY` and so on, direct transport) or a configured n8n gateway;
the Hub's data directory (`PATENT_RESEARCH_DATA_DIR`) holds what Patent Genius retrieves through it. We intend to keep
the exports and call signatures above stable across 0.1.x and 0.2.x. Only the gateway contract (the two exports, the `uspto`
route body and the `{text, status, contentType}` envelope with a returned status) is exercised by this repository's
tests (`test/direct.test.mjs`); the other imports are not covered here, so check Patent Genius's own notes after
upgrading the Hub.

## Provider quotas

The Hub's direct transport applies local safeguards to every keyed provider and key, shared by all Hub processes of the same
user (state in one per-user limiter folder, independent of the data folder and the config file; see `limiterDir` in the README): **one call at a time** (a caller that finds the key busy waits for its
turn), a minimum spacing between request starts (`directMinIntervalMs`), a cap on calls per rolling hour (calls, not HTTP attempts;
`maxRequestsPerHour`, default 1800 for USPTO, EPO, GovInfo, CourtListener and BigQuery; `0` disables it) and a cooldown after
HTTP 429 (at least 5 seconds, as long as `Retry-After` says if longer, up to 24 hours; doubling on repeats, the doubling capped at 15 minutes). Only an exhausted
hourly cap raises an error, with the code `local_limit` (property `retryAfterSeconds`, `limit`) and the wait time in the
message; waiting longer than `limiterMaxWaitMs` raises `local_busy`. The README section "USPTO key rules and the Hub's
limits" lists the portal's published rules. These limits are not your provider's quota: USPTO sets per-key limits, EPO OPS has a weekly fair-use quota,
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
which must export a `CorpusClient` class, for example Get Files' `integrations/client.mjs`. Intake checks that the
corpus reports **Context Forge** as the normalizer of each document (its manifest `extractor` must start with
`Context Forge /`), so use a Get Files corpus that normalizes with Context Forge; a corpus using any other normalizer is
refused. See [PATENTSVIEW.md](PATENTSVIEW.md).

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
