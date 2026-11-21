# Patent Research Hub

**Public preview 0.2.0** — Apache-2.0. Published by Brightline IP.

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
| USPTO Open Data Portal | Patent file-wrapper search, PTAB trial and ex parte appeal decisions, application document lists, identity-checked original PDFs, office-action rejection records (the `oa-rejections` gateway route, see below) | `USPTO_API_KEY` |
| EPO Open Patent Services | Bibliographic lookup by EPODOC publication number | `EPO_OPS_CONSUMER_KEY` + `EPO_OPS_CONSUMER_SECRET` |
| GovInfo | USCOURTS opinion search | `GOVINFO_API_KEY` |
| CourtListener | Opinion search (disabled by default; requires accepting Free Law Project terms) | `COURTLISTENER_TOKEN` + config |
| Google BigQuery | Fixed CPC publication-year trend and hosted-PatEx examiner/art-unit outcome aggregates; **dry-run byte estimates by default** | `GOOGLE_APPLICATION_CREDENTIALS` + `BIGQUERY_PROJECT_ID` |
| Reference library | MPEP chapters, 35 USC and 37 CFR consolidations, FRCP: a manifest of official URLs and SHA-256 pins plus a fetch command | No |
| Local datasets | PatentsView annualized grant cohort (you download and prepare it), PatEx (via BigQuery) | No |
| Link-only | WIPO PATENTSCOPE and IP Statistics, Google Patents, FreePatentsOnline, Patent Bots, Juristat, Patlytics | No automated retrieval |

CPC scheme lookups (`src/epo-cpc.mjs`) and GovInfo opinion PDF download (`src/govinfo-pdf.mjs`) exist as module
functions that other tools can import. No CLI command or MCP tool calls them, so they are not part of what the
command line or an assistant can do today.

Every retrieval is saved as an immutable response snapshot plus normalized records in a local SQLite database, so
earlier results stay searchable offline. Reports are exported as JSON, Markdown and HTML (with CSV for statistics, and
a chart only when Python with matplotlib is available; without them the report is still written, with a warning and no chart). Report tools put `warnings` first in their result; if writing the files fails after a paid BigQuery query, the result is still returned with an `exportError` field.

## Requirements

- Node.js **24.13 or newer** (the Hub uses the built-in `node:sqlite` module). Windows, macOS or Linux; the
  developers use Windows, and other systems have not been tested.
- Optional: Python 3.12 or newer with `requirements.txt` (matplotlib). Python is needed only for the **charts** in
  reports and for PatentsView preparation. Reports still work without it: they are written with a warning and no chart.
- Optional: your own provider credentials (table above). Nothing is needed for the keyless sources.

## Install on Windows (easiest)

1. Download `patent-research-hub-0.2.0.zip` from the release page and check its SHA-256 against the value in the
   release notes. In PowerShell: `Get-FileHash .\patent-research-hub-0.2.0.zip -Algorithm SHA256`
2. Right-click the zip, choose **Extract All**, open the extracted folder and double-click **Setup.cmd**. The script
   is not code-signed, so Windows SmartScreen may warn you; choose More info, Run anyway only if the checksum matched.
3. Setup checks for Node.js (required) and Python (optional: charts in reports, which are still produced without it, and
   PatentsView preparation).
   If one is missing it explains why, shows the exact `winget` command and installs it only if you answer yes.
   Both are free. No administrator rights, Docker or API key are needed.
4. Setup copies the program to `%LOCALAPPDATA%\Brightline\PatentResearchHub`, runs `npm ci --omit=dev` from
   `package-lock.json`, and creates a separate data folder, `%LOCALAPPDATA%\Brightline\PatentResearchHub-Data`, that
   only your Windows account can read. It holds your database, exports, `config.json` (BigQuery stays in dry-run
   mode) and an empty `keys.env`. Setup never asks for a key and changes no AI assistant's configuration.
5. When it finishes, Setup runs the check and opens a getting-started guide. Sources without a key show
   "not configured"; the keyless sources work straight away.

Start Menu, folder **Patent Research Hub**:

- **Check**: which sources are ready (setting names only, never key values; no network call).
- **Data folder**: opens the data folder, where `keys.env` and `config.json` are.
- **Documentation**: the getting-started guide (where keys go, how to connect an assistant).
- **Repair**: reinstalls the npm packages, may offer any missing prerequisite (Node.js, optional Python) with your yes,
  re-applies the protection on `keys.env`, refreshes the optional chart packages if the private `.venv` exists, and regenerates `Hub.cmd`, the MCP setup files, the getting-started guide
  and the shortcuts. It does not replace program files (run `Setup.cmd` from a newer download for that) and does not
  touch your data, settings or key values. It does not open the guide in Notepad.
- **Uninstall**: removes the program and shortcuts; keeps the data folder unless you choose to delete it. It ends by
  saying whether the program folder and the data folder were deleted or kept.

**Keys.** Open `keys.env` from the data folder in Notepad, paste each value after its `=` sign, save, and run
**Check**. Registering for the USPTO, EPO OPS, GovInfo and CourtListener keys is free (each provider sets its own
terms and limits); BigQuery can cost money on a billing-enabled Google Cloud project, which is why the Hub only makes
free dry-run estimates until you change `config.json`. Nothing leaves your computer until you use a source; then
your query terms, document numbers and that provider's key go to that provider only.

**AI assistants.** Setup writes `MCP-setup.json` (Claude Desktop, Claude Code) and `MCP-setup.codex.toml` (Codex)
in the program folder. Merge the `patent_research` entry into your client's configuration yourself. The entry starts
Node with `--env-file-if-exists=<data folder>\keys.env`, so keys stay in that one file and out of client settings.
A variable that is already set in your Windows environment takes precedence: Node's `--env-file` does not override
it, so a stale `USPTO_API_KEY` set elsewhere will win over the one in `keys.env`.
From a command prompt, `"%LOCALAPPDATA%\Brightline\PatentResearchHub\Hub.cmd" doctor` runs the CLI with the same
folders and keys.

Running Setup again repairs or updates the installation. `Setup.cmd -DryRun` shows what it would do without
changing anything; `-InstallRoot`, `-DataRoot` and `-ShortcutFolder` choose other folders. If Hub processes from this
installation are running (an AI assistant usually starts them), Setup explains and asks before stopping them (default:
no). **An update replaces the program folder with the new download: anything you saved inside the program folder is
deleted.** Keep your own files in the data folder or elsewhere. The program folder and the folder you extracted the
download into must not contain one another; Setup refuses that before copying anything. If the package download fails
during an update, the Hub is unusable until Setup is run again (Setup.cmd, or the Repair shortcut).

## Install from source

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
`node --env-file=.env src/cli.mjs doctor`. `--env-file` does not override a variable that is already set in your
environment (the existing value wins). `node src/cli.mjs` with no arguments lists every command.

A source without its key returns `{"status":"not_configured", "missing":[...], "register":"<signup link>"}`
(CLI exit code 2) instead of failing.

## MCP client registration

The MCP server speaks stdio and exposes 36 tools (`research_doctor`, `research_sources`, `research_query`,
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
| `maxRequestsPerHour` | 1800 per keyed provider (USPTO, EPO, GovInfo, CourtListener, BigQuery); 0 = unlimited | Local limit on **calls** (turns at the key, not HTTP attempts) per provider and key, **shared by every Hub process of the same user** (state in the per-user limiter folder, see `limiterDir`). Not the provider's own quota. 1800 an hour (one every 2 s on average) stays well inside the portal's published rates; you may lower it. `Hub.cmd gateway --limits` prints the effective value. When it is used up, calls fail with the error code `local_limit` and the wait time. |
| `limiterMaxWaitMs` | `1200000` (20 min) | The longest a call waits for its turn, the pacing gap or a 429 cooldown before it fails with `local_busy` and the wait time. |
| `limiterStaleLockMs` | `30000` (at least `5000`) | A call lock that nobody has refreshed for this long (the holder died or hung) is taken over. |
| `PATENT_RESEARCH_LIMITER_DIR` / `limiterDir` | `%LOCALAPPDATA%\PatentResearchHub\limiter` (Windows), `$XDG_STATE_HOME/patent-research-hub/limiter` or `~/.local/state/patent-research-hub/limiter` | Where the cross-process limiter keeps its lock, counters and salt. One folder per user, **independent of the data folder, the install folder and the config file**, so every Hub process of this user (MCP server, CLI, `gateway` children, programs that import the Hub) takes turns at the same lock. Change it only if every caller agrees; it is not removed by the uninstaller (delete `%LOCALAPPDATA%\PatentResearchHub` yourself if you want it gone). |
| `oaRejectionsAdapter` | `legacy-rejections-v2` | Which USPTO service answers the `oa-rejections` route. Only the legacy Rejections API is implemented. |
| `directMinIntervalMs` | USPTO/EPO/CourtListener/BigQuery/public 1000 ms, GovInfo 3600 ms | Minimum spacing between request starts to one provider and key (across processes for keyed providers). |
| `requestTimeoutMs` | `25000` | Per-request timeout (PTAB originals 60 s, application originals and BigQuery 180 s). |
| `ptabOriginalsEnabled`, `patentDocumentsEnabled`, `patentDocumentOriginalsEnabled` | `true` | Allow the USPTO document list and identity-checked original downloads. |
| `PATENT_RESEARCH_DATA_DIR` / `dataDir` | `<install>/data` | Local database, backups, checkpoints, staged originals, reference PDFs. |
| `PATENT_RESEARCH_EXPORTS_DIR` / `exportsDir` | `<install>/exports` | Exported reports. |
| `RESEARCH_PYTHON` / `pythonExecutable` | `.venv`, then Python on PATH | Charts in reports (optional; without Python the report has no chart and says so) and PatentsView preparation. |
| `RESEARCH_GET_FILES_CLIENT` / `getFilesClientModule` | — | Optional [Get Files](docs/INTEGRATION.md) integration for archiving and full-text reading. |
| `RESEARCH_CORPUS_CLIENT` / `corpusClientModule` | — | Optional corpus client for PatentsView intake. |
| `corpusIntakeRoot` | `<dataDir>/intake` | Where verified originals are staged. |

Network behaviour on the direct transport: HTTPS only, fixed provider hosts and paths (the same validation the n8n
workflows use), no redirects followed except the one identity-checked USPTO signed download, response size caps,
timeouts, and retries with backoff (`Retry-After` honoured, at most 5 s) **only for idempotent GET requests and only for
HTTP 5xx**. POST searches and BigQuery calls are never retried. HTTP 429 is never retried at once: see the next section.

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

## USPTO key rules and the Hub's limits

The Open Data Portal publishes its rules at [data.uspto.gov/apis/getting-started](https://data.uspto.gov/apis/getting-started)
and [data.uspto.gov/apis/api-rate-limits](https://data.uspto.gov/apis/api-rate-limits) (read 2026-11-20; the portal says
its limits are subject to change, so check them yourself). In our own words:

- **Getting and keeping a key.** A key needs a USPTO.gov account with multi-factor sign-in and an identity verified through
  ID.me (applicants outside the US verify on a video call). One key per account; do not share it. **A key that is not used
  for 90 days is deleted** and has to be requested again, so an idle Hub can find its key gone.
- **One call at a time per key.** The portal blocks concurrent calls made with the same key.
- **Rate.** Roughly 4 to 15 requests per second depending on the kind of call. There are also weekly quotas (millions of
  metadata calls, fewer document downloads, reset on Sunday 00:00 UTC) that are far above what this tool does; we do not
  promise figures because the portal can change them.
- **After an HTTP 429** ("too many requests"): wait at least 5 seconds before trying again, and never retry automatically
  sooner.

What the Hub does about it, for every keyed provider (USPTO, EPO, GovInfo, CourtListener, BigQuery):

- **One call at a time per key, across processes.** A lock file in the per-user limiter folder is held for the whole call, so the MCP
  server, the command line, `gateway` children started by other tools and programs that import the Hub take turns. A caller that finds the key busy
  **waits** for its turn, and gives up with `local_busy` (and the wait time) only if the wait would exceed `limiterMaxWaitMs`. A lock whose holder died, or that has not been refreshed for
  `limiterStaleLockMs`, is taken over (one waiter at a time). The key itself is never written there: files are named by a truncated SHA-256 of the provider, a random per-install salt and the key.
- **Spacing and an hourly cap.** `directMinIntervalMs` (1 s for USPTO by default, far below the published rate) and
  `maxRequestsPerHour` (1800 by default; it counts calls, not HTTP attempts) apply across processes. Only when the hourly cap is really used up does a call fail,
  with the error code `local_limit` and the wait time in the message (`retry_after_seconds` in the `gateway` command).
- **After a 429** the Hub returns the 429 to the caller (with `retryAfterSeconds`) and holds the key back, for every process,
  for at least 5 seconds, for as long as `Retry-After` says if that is longer (up to 24 hours), and twice as long after each further 429
  in a row (the doubling stops at 15 minutes). The next call waits that out, or fails with `local_busy` and the wait time if waiting
  would exceed `limiterMaxWaitMs`.
- Times come from the computer's clock: a clock that jumps by minutes can shorten or lengthen one wait or one lock expiry.
- The locks are advisory and local to one user on one computer. They do not stop another program or another
  computer using the same key.

## Office-action rejection records

The `oa-rejections` route (direct transport, `USPTO_API_KEY`) asks the USPTO Office Action Rejection API (v2) which
statutory rejections (101, 102, 103, 112, double patenting) appear in the office actions of up to 100 applications at a
time, identified by their **8-digit application numbers only**. The endpoint is fixed, the search criteria are built by
the Hub, and the answer's HTTP status is taken from the HTTP response. A reply that does not have the documented shape is
an error (502), never "zero records". The records have no examiner name and no cited-reference identities, and the
coverage start and the reporting lag are not fixed: compute them from the data. The USPTO marks this API **legacy**; the
code sits behind a small adapter (`src/oa-adapter.mjs`) so a move to the newer Office Action Search API is a contained
change, but that API is not implemented (see [docs/INTEGRATION.md](docs/INTEGRATION.md#office-action-rejections-and-the-legacy-api)).
The documentation does not say how an empty result is answered. The n8n route returned a normal body with `numFound: 0` for an application with no office actions in a live probe, so the provider appears to answer with a normal 200-shaped body, but that is inferred and not proven for the direct route; a 404 is therefore passed through as a 404 and never read as zero records. It is reachable through the module gateway and the `gateway` command below, not through an MCP tool or a CLI query command.

## Using the Hub from another tool (`gateway` command)

Another program can use the Hub's provider access without ever holding your keys: it starts
`Hub.cmd gateway <route> --json-in` (or `node src/cli.mjs gateway <route> --json-in`) as a short-lived child, writes one
JSON request to stdin and reads one JSON document from stdout. `Hub.cmd` loads `keys.env` for the child only. See
[docs/INTEGRATION.md](docs/INTEGRATION.md#gateway-command-the-supported-way-for-other-tools).

## Provider terms

Each user registers for and uses their own credentials and must follow each provider's terms and rate limits. The Hub spaces
requests (`directMinIntervalMs`) and stops at `maxRequestsPerHour` per provider and key (default 1800, shared by all Hub processes on one data folder); both are
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

There is **no automatic retention or pruning**. Response snapshots, backups, checkpoints, staged originals and
exported reports accumulate until you delete them yourself (the `backup` command never removes earlier backups).
Check the data folder's size now and then, and delete old backup, export or checkpoint files yourself. The Hub has no
command that prunes records or snapshots inside `research.sqlite`.

No provider data, reference PDFs or credentials ship with the software.

## Security model

- Credentials are read from environment variables at call time, sent only to their own provider host, held in
  memory only (OAuth tokens included), and never written to the database, reports, checkpoints or logs.
  `doctor` reports which variables are set, never their values. Error messages are redacted.
- The Hub contacts only fixed HTTPS provider endpoints; caller input cannot choose a host, path or SQL text.
- Retrieved text is untrusted data. Tool results label coverage limits; a search page is never a population.
- The optional n8n transport requires a bearer file you create and talks to n8n over loopback http by default. The one
  exception is an explicit opt-in: set `n8nRemoteHost` to the exact hostname of an n8n you operate and `n8nBaseUrl` to
  `https://<that host>` (a bare origin). The gateway bearer token then travels over the network, so use it only for a
  host you control. `n8nRemoteHost` is empty by default.
- `getFilesClientModule`, `corpusClientModule` and their `RESEARCH_*` environment variables name JavaScript that the Hub imports
  and runs with your user rights: set them only in configuration you control (see [SECURITY.md](SECURITY.md).)
- There is no application-level encryption of the local database; protect the data folder like any other
  research file. Do not send client-confidential material to providers. See [SECURITY.md](SECURITY.md).

## Limitations

- Direct transport: offline-tested only (see the note at the top). The `oa-rejections` route and the cross-process limiter have never been run against the live USPTO API.
- `oa-rejections` uses the USPTO's legacy Rejections API; the successor (Office Action Search API) is not implemented.
- File-form and XML-archive application downloads (`fileId`/`format`) work only with the n8n transport.
- Reference full-text search (`research_reference_search`), archiving and passage reading need the optional Get
  Files integration. Without it, `references-fetch` still downloads and hash-checks the official PDFs.
- The hosted PatEx table on BigQuery dates from 2017; examiner outcomes after that need the official USPTO bulk
  release. Google Patents counts are publication counts, not filings or families.
- The model proxy (`src/model-proxy.mjs`) and the PatentsView landscape form are n8n-only extras.
- No licensed citator: later treatment of a decision is never checked.
- Python packages in `requirements.txt` are version-pinned, not hash-pinned (the Windows installer installs wheels only,
  `--only-binary=:all:`, but does not verify hashes). The npm packages are pinned by `package-lock.json` with hashes.
- PatentsView cohort intake (`patentsview-intake`, `patentsview-install`) accepts a corpus only if its normalized
  document names Context Forge as the normalizer (see [docs/PATENTSVIEW.md](docs/PATENTSVIEW.md)); any other corpus
  client is refused.
- Clean-machine installation on macOS and Linux has not been tested.

## Testing

```sh
npm test        # offline: mocked providers, no network, no live services
```

## Uninstall

Installed with Setup.cmd: use **Patent Research Hub - Uninstall** in the Start Menu. It stops Hub processes started
from this installation (for example by an AI assistant), removes the program folder and shortcuts, and keeps the data
folder unless you answer yes to deleting it. From a script: `installer\remove.ps1 -KeepData -Yes` or
`-RemoveData -Yes` in the program folder. If the program folder or the data folder is itself a link (junction or symbolic link), only the link is removed and its target is left as it is; the output says so. Node.js and Python stay installed, and you remove the `patent_research`
entry from your MCP client configuration yourself.

Installed from source: delete the install folder. Your data is in `<dataDir>` and `<exportsDir>` (inside the install folder unless you
set `PATENT_RESEARCH_DATA_DIR` / `PATENT_RESEARCH_EXPORTS_DIR`); delete those too if you no longer need them, and
remove the `patent_research` entry from your MCP client configuration.

## More

- [docs/INTEGRATION.md](docs/INTEGRATION.md) — gateway module for other tools (Patent Genius), Get Files, other agents
- [docs/BIGQUERY_SETUP.md](docs/BIGQUERY_SETUP.md), [docs/EXAMINER_ANALYTICS.md](docs/EXAMINER_ANALYTICS.md)
- [docs/REFERENCE_LIBRARY.md](docs/REFERENCE_LIBRARY.md), [docs/PTAB_ORIGINALS.md](docs/PTAB_ORIGINALS.md)
- [docs/PERSISTENCE.md](docs/PERSISTENCE.md), [docs/PATENTSVIEW.md](docs/PATENTSVIEW.md), [docs/WIPO_ACCESS.md](docs/WIPO_ACCESS.md)
- [extras/n8n/README.md](extras/n8n/README.md) — optional n8n transport
- [DISCLAIMER.md](DISCLAIMER.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md)
