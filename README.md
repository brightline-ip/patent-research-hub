# Patent Research Hub

**Public preview 0.1.0** — Apache-2.0. Published by Brightline IP.

Patent Research Hub retrieves public US patent and legal sources for an AI assistant or a script, keeps a local,
provenance-tracked record of what it retrieved, and exports source-linked evidence packets. It is a
**deterministic retrieval layer**: it makes no model calls, accepts no arbitrary SQL or URLs, and never presents a
search page as a complete population or a legal conclusion.

It is meant for patent practitioners and researchers who want an MCP client (Claude Desktop, Claude Code, Codex
and others) or a command line to pull Federal Circuit opinions, PTAB decisions, USPTO file-wrapper records, EPO
bibliography, MPEP/35 USC/37 CFR references and Google-hosted patent statistics with their provenance intact.
Read [DISCLAIMER.md](DISCLAIMER.md): output is not legal advice and must be checked against the official record.

> **Direct transport has not been verified against live providers.** In this release the default direct
> transport (the Hub calling USPTO, EPO, GovInfo, CourtListener and BigQuery itself) is covered only by offline
> tests with mocked provider responses. Request shapes follow each provider's documentation and the n8n workflows
> the Hub was originally built and live-tested with, but expect to find provider-side differences. Please report
> them (see [SECURITY.md](SECURITY.md) for security issues).

## What it does

| Area | Sources | Key needed |
| --- | --- | --- |
| Court and Board decisions | Federal Circuit RSS (opinions/orders), PTAB precedential/informative index, PTAB statistics, Director Review pages | No |
| Official notices | USPTO Official Gazette, e-FOIA reading rooms, examination guidance index | No |
| USPTO Open Data Portal | Patent file-wrapper search, PTAB trial and ex parte appeal decisions, application document lists, identity-checked original PDFs | `USPTO_API_KEY` |
| EPO Open Patent Services | Bibliographic lookup by EPODOC publication number; CPC scheme lookups | `EPO_OPS_CONSUMER_KEY` + `EPO_OPS_CONSUMER_SECRET` |
| GovInfo | USCOURTS opinion search and opinion PDFs | `GOVINFO_API_KEY` |
| CourtListener | Opinion search (disabled by default; requires accepting Free Law Project terms) | `COURTLISTENER_TOKEN` + config |
| Google BigQuery | Fixed CPC publication-year trend and hosted-PatEx examiner/art-unit outcome aggregates; **dry-run byte estimates by default** | `GOOGLE_APPLICATION_CREDENTIALS` + `BIGQUERY_PROJECT_ID` |
| Reference library | MPEP chapters, 35 USC and 37 CFR consolidations, FRCP: a manifest of official URLs and SHA-256 pins plus a fetch command | No |
| Local datasets | PatentsView annualized grant cohort (you download and prepare it), PatEx (via BigQuery) | No |
| Link-only | WIPO PATENTSCOPE and IP Statistics, Google Patents, FreePatentsOnline, Patent Bots, Juristat, Patlytics | No automated retrieval |

Every retrieval is saved as an immutable response snapshot plus normalized records in a local SQLite database, so
earlier results stay searchable offline. Reports are exported as JSON, Markdown and HTML (with CSV and charts for
statistics).

## Requirements

- Node.js **24.13 or newer** (the Hub uses the built-in `node:sqlite` module). Windows, macOS or Linux; the
  developers use Windows, and other systems have not been tested.
- Optional: Python 3 with `requirements.txt` (matplotlib) for report charts and PatentsView preparation.
- Optional: your own provider credentials (table above). Nothing is needed for the keyless sources.

## Install

```sh
git clone <this repository> patent-research-hub
cd patent-research-hub
npm ci
# optional, for charts:
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt   # Windows
# python3 -m venv .venv && .venv/bin/pip install -r requirements.txt               # macOS/Linux
```

`npm ci` downloads the four npm dependencies and their transitive packages. No service, scheduled task or
background process is installed.

## Quick start

```sh
node src/cli.mjs doctor                         # which sources are configured (names only, never values)
node src/cli.mjs refresh --source cafc          # recent Federal Circuit opinions and orders (no key)
node src/cli.mjs search --query "obviousness"   # search what you have saved locally
node src/cli.mjs query --source odp --query 'applicationMetaData.inventionTitle:"robot"' --limit 5   # needs USPTO_API_KEY
node src/cli.mjs bigquery-estimate --cpc G06N --from 2024 --to 2024                                  # dry run only
node src/cli.mjs references-fetch --source usc35                                                     # official PDF, hash-checked
```

To load keys from a local file: copy `.env.example` to `.env`, fill in what you have, and run
`node --env-file=.env src/cli.mjs doctor`. `node src/cli.mjs` with no arguments lists every command.

A source without its key returns `{"status":"not_configured", "missing":[...], "register":"<signup link>"}`
(CLI exit code 2) instead of failing.

## MCP client registration

The MCP server speaks stdio and exposes 37 tools (`research_doctor`, `research_sources`, `research_query`,
`research_refresh`, `research_search`, `research_record`, BigQuery, examiner, reference-library, report,
checkpoint and backup tools). Example for Claude Desktop or any client that uses the `mcpServers` format — use
absolute paths:

```json
{
  "mcpServers": {
    "patent_research": {
      "command": "node",
      "args": ["/absolute/path/to/patent-research-hub/src/mcp.mjs"],
      "env": {
        "USPTO_API_KEY": "your-key",
        "PATENT_RESEARCH_DATA_DIR": "/absolute/path/to/patent-research-data"
      }
    }
  }
}
```

Allow a generous tool timeout (about 4 minutes) for BigQuery and original-document tools. The optional skill text in
`skills/patent-research/SKILL.md` tells an agent how to use the tools conservatively.

## Configuration

Settings come from an optional `config.json` in the install folder (copy `config.example.json`; it is git-ignored)
or the file named by `PATENT_RESEARCH_CONFIG`. Credentials are **only** read from environment variables.

| Setting / variable | Default | Meaning |
| --- | --- | --- |
| `transport` / `PATENT_RESEARCH_TRANSPORT` | `direct` | `direct`: the Hub calls providers itself. `n8n`: optional loopback n8n holds the credentials ([extras/n8n](extras/n8n/README.md)). |
| `USPTO_API_KEY` | — | USPTO Open Data Portal key. [Register](https://data.uspto.gov/apis/getting-started). |
| `EPO_OPS_CONSUMER_KEY`, `EPO_OPS_CONSUMER_SECRET` | — | EPO OPS application credentials; the Hub obtains and caches OAuth tokens in memory. [Register](https://developers.epo.org/user/register). `EPO_ACCESS_TOKEN` is accepted as a short-lived alternative. |
| `GOVINFO_API_KEY` | — | GovInfo (api.data.gov) key. [Register](https://www.govinfo.gov/api-signup). |
| `COURTLISTENER_TOKEN` | — | CourtListener API token. [API docs](https://wiki.free.law/c/courtlistener/help/api/rest/v4/rest-api-v47). |
| `courtlistenerEnabled`, `courtlistenerInternalUseAllowed` | `false`, `false` | Both must be `true` before CourtListener is used. Set the second only after reading the [Free Law Project allowed-use terms](https://free.law/membership/allowed-api-usage/). |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to a Google service-account key or `gcloud auth application-default login` credential file. |
| `BIGQUERY_PROJECT_ID` / `googleBigQueryProjectId` | — | Your own Google Cloud project (queries are run and billed there). |
| `googleBigQueryDryRunEnabled` | `true` | Free dry-run byte estimates. |
| `googleBigQueryExecutionEnabled` | `false` | Allows capped data queries. Also needs `googleBigQueryBillingMode`. |
| `googleBigQueryBillingMode` | `disabled` | `sandbox-no-billing` (BigQuery sandbox, no billing account) or `billing-enabled-capped` (you accept possible charges up to the caps). |
| `googleBigQueryPerQueryMaxBytes` | `26843545600` (25 GiB) | Sent as `maximumBytesBilled`; a dry-run estimate above it is refused before execution. |
| `googleBigQueryMonthlyTrackedMaxBytes` | `274877906944` (256 GiB) | Calendar-month budget tracked locally for queries made by this tool only. |
| `maxRequestsPerHour` | 120 per keyed provider (USPTO, EPO, GovInfo, CourtListener, BigQuery); 0 = unlimited | Local request-count limit per provider and process. Not the provider's own quota. |
| `directMinIntervalMs` | USPTO/EPO/CourtListener/BigQuery/public 1000 ms, GovInfo 3600 ms | Minimum spacing between requests to one provider. |
| `requestTimeoutMs` | `25000` | Per-request timeout (PTAB originals 60 s, application originals and BigQuery 180 s). |
| `ptabOriginalsEnabled`, `patentDocumentsEnabled`, `patentDocumentOriginalsEnabled` | `true` | Allow the USPTO document list and identity-checked original downloads. |
| `PATENT_RESEARCH_DATA_DIR` / `dataDir` | `<install>/data` | Local database, backups, checkpoints, staged originals, reference PDFs. |
| `PATENT_RESEARCH_EXPORTS_DIR` / `exportsDir` | `<install>/exports` | Exported reports. |
| `RESEARCH_PYTHON` / `pythonExecutable` | `.venv`, then Python on PATH | Charts and PatentsView preparation. |
| `RESEARCH_GET_FILES_CLIENT` / `getFilesClientModule` | — | Optional [Get Files](docs/INTEGRATION.md) integration for archiving and full-text reading. |
| `RESEARCH_CORPUS_CLIENT` / `corpusClientModule` | — | Optional corpus client for PatentsView intake. |
| `corpusIntakeRoot` | `<dataDir>/intake` | Where verified originals are staged. |

Network behaviour on the direct transport: HTTPS only, fixed provider hosts and paths (the same validation the n8n
workflows use), no redirects followed except the one identity-checked USPTO signed download, response size caps,
timeouts, and retries with backoff (`Retry-After` honoured, at most 5 s) **only for idempotent GET requests**.
POST searches and BigQuery calls are never retried.

## BigQuery cost warning

BigQuery charges by bytes scanned. A single CPC trend query over the Google Patents publications table can scan
tens of GiB (one 2021–2025 G06N query scanned about 16.5 GiB). At on-demand prices that is a fraction of a dollar
per query, and Google currently gives every project a free monthly allowance, but **prices, free tiers and your
project's billing state are your responsibility**. The Hub therefore:

- runs only fixed, parameterized SQL; it never accepts SQL from a caller;
- defaults to dry runs, which return a byte estimate and process no data;
- runs a data query only when `googleBigQueryExecutionEnabled` is `true` **and** a billing mode is acknowledged,
  after a fresh dry run under `googleBigQueryPerQueryMaxBytes`, with that ceiling sent to Google as
  `maximumBytesBilled`, and only while the local monthly ledger stays under `googleBigQueryMonthlyTrackedMaxBytes`;
- cannot see queries you run elsewhere (console, other tools), so the monthly ledger is a floor, not your bill. Google enforces
  only the per-query `maximumBytesBilled`; the monthly cap is a local ledger, and reconciling an interrupted reservation is an
  operator-only CLI step (`bigquery-reconcile`, never an MCP tool).

Use a BigQuery sandbox project (no billing account) if you want a hard stop. See
[docs/BIGQUERY_SETUP.md](docs/BIGQUERY_SETUP.md) and [Google's pricing page](https://cloud.google.com/bigquery/pricing).

## Provider terms

Each user registers for and uses their own credentials and must follow each provider's terms and rate limits. The Hub spaces
requests (`directMinIntervalMs`) and stops at `maxRequestsPerHour` per provider (default 120, this process only); both are
local safeguards, not your provider's quota (see [docs/INTEGRATION.md](docs/INTEGRATION.md#provider-quotas)):
[USPTO Open Data Portal](https://data.uspto.gov/apis/getting-started),
[EPO OPS terms](https://www.epo.org/en/service-support/ordering/terms-and-conditions/ops-terms-and-conditions) and
[fair-use charter](https://www.epo.org/en/service-support/ordering/fair-use),
[GovInfo API](https://github.com/usgpo/api),
[CourtListener allowed API usage](https://free.law/membership/allowed-api-usage/) (membership-based; organizational
or commercial use may need Free Law Project's agreement),
[Google BigQuery pricing](https://cloud.google.com/bigquery/pricing). WIPO PATENTSCOPE prohibits robots and bulk
downloads, and Patent Bots prohibits systematic downloading; the Hub only generates links for those services.
More in [docs/FREE_SOURCES.md](docs/FREE_SOURCES.md) and [docs/OPTIONAL_CONNECTORS.md](docs/OPTIONAL_CONNECTORS.md).

## Data locations

Everything stays on your computer unless you call a provider:

- `<dataDir>/research.sqlite` — saved records, response snapshots, run history, BigQuery ledger, aggregate cache.
- `<dataDir>/backups`, `<dataDir>/recovery` — `backup` and `restore-stage` output.
- `<dataDir>/checkpoints` — research handoffs (`research_checkpoint`).
- `<dataDir>/intake` — verified original PDFs staged for an optional corpus.
- `<dataDir>/references` — official reference PDFs fetched by `references-fetch`.
- `<dataDir>/patentsview` — PatentsView snapshots you prepare.
- `<exportsDir>/<uuid>/` — exported reports.

No provider data, reference PDFs or credentials ship with the software.

## Security model

- Credentials are read from environment variables at call time, sent only to their own provider host, held in
  memory only (OAuth tokens included), and never written to the database, reports, checkpoints or logs.
  `doctor` reports which variables are set, never their values. Error messages are redacted.
- The Hub contacts only fixed HTTPS provider endpoints; caller input cannot choose a host, path or SQL text.
- Retrieved text is untrusted data. Tool results label coverage limits; a search page is never a population.
- The optional n8n transport requires a loopback n8n address and a bearer file you create.
- `getFilesClientModule`, `corpusClientModule` and their `RESEARCH_*` environment variables name JavaScript that the Hub imports
  and runs with your user rights: set them only in configuration you control (see [SECURITY.md](SECURITY.md).)
- There is no application-level encryption of the local database; protect the data folder like any other
  research file. Do not send client-confidential material to providers. See [SECURITY.md](SECURITY.md).

## Limitations

- Direct transport: offline-tested only (see the note at the top).
- File-form and XML-archive application downloads (`fileId`/`format`) work only with the n8n transport.
- Reference full-text search (`research_reference_search`), archiving and passage reading need the optional Get
  Files integration. Without it, `references-fetch` still downloads and hash-checks the official PDFs.
- The hosted PatEx table on BigQuery dates from 2017; examiner outcomes after that need the official USPTO bulk
  release. Google Patents counts are publication counts, not filings or families.
- The model proxy (`src/model-proxy.mjs`) and the PatentsView landscape form are n8n-only extras.
- No licensed citator: later treatment of a decision is never checked.
- Clean-machine installation on macOS and Linux has not been tested.

## Testing

```sh
npm test        # offline: mocked providers, no network, no live services
```

## Uninstall

Delete the install folder. Your data is in `<dataDir>` and `<exportsDir>` (inside the install folder unless you
set `PATENT_RESEARCH_DATA_DIR` / `PATENT_RESEARCH_EXPORTS_DIR`); delete those too if you no longer need them, and
remove the `patent_research` entry from your MCP client configuration.

## More

- [docs/INTEGRATION.md](docs/INTEGRATION.md) — gateway module for other tools (Patent Genius), Get Files, other agents
- [docs/BIGQUERY_SETUP.md](docs/BIGQUERY_SETUP.md), [docs/EXAMINER_ANALYTICS.md](docs/EXAMINER_ANALYTICS.md)
- [docs/REFERENCE_LIBRARY.md](docs/REFERENCE_LIBRARY.md), [docs/PTAB_ORIGINALS.md](docs/PTAB_ORIGINALS.md)
- [docs/PERSISTENCE.md](docs/PERSISTENCE.md), [docs/PATENTSVIEW.md](docs/PATENTSVIEW.md), [docs/WIPO_ACCESS.md](docs/WIPO_ACCESS.md)
- [extras/n8n/README.md](extras/n8n/README.md) — optional n8n transport
- [DISCLAIMER.md](DISCLAIMER.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md)
