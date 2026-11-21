# Changelog

## 0.2.0 — 2026-11-20

Public preview 0.2.0. Adds what Patent Genius 0.1.0 needs from the Hub. Offline-tested with mocked providers only; none of it
has been run against the live USPTO API.

- **Office-action rejections on the direct transport.** New `oa-rejections` route (provider `uspto`, `X-API-KEY`) behind a small
  adapter (`src/oa-adapter.mjs`, setting `oaRejectionsAdapter`). It reuses the request validation of the n8n route
  (8-digit application numbers only, fixed endpoint `.../oa_rejections/v2/records` and `/fields`). The status comes from the
  HTTP response, and a reply without `response.numFound` and `response.docs` (or `fields`) is a 502, never zero records.
  The USPTO marks this API legacy; the newer Office Action Search API is not implemented (its documentation could not be read
  without signing in).
- **Empty search windows.** The direct ODP search route turns the provider's HTTP 404 "no matching records" into a valid
  zero-count result (`count: 0`, as the n8n workflow does); any other 404, other statuses and a 200 carrying that text are
  unchanged.
- **One call at a time per key, across processes.** New cross-process limiter (`src/limiter.mjs`, state in one per-user folder, `%LOCALAPPDATA%\PatentResearchHub\limiter`, independent of the data folder, so importing programs and `Hub.cmd` always share it; overridable with `PATENT_RESEARCH_LIMITER_DIR`): a lock held for the whole call that callers wait for (stale locks from dead or hung holders are taken
  over, one waiter at a time, and the holder confirms its lock before every write of state and before it sends; a holder that lost the lock writes nothing, and a read that merely fails once is never taken as loss), minimum spacing across processes, and `maxRequestsPerHour` now shared across processes (it was per process). Only a truly
  exhausted cap fails, with the new error code `local_limit` and the wait time; waiting longer than the new
  `limiterMaxWaitMs` fails with `local_busy`. New settings `limiterMaxWaitMs` and `limiterStaleLockMs`.
- **HTTP 429.** Never retried at once. The Hub returns the 429 (with `retryAfterSeconds`) and holds the key back for every
  process for at least 5 seconds, `Retry-After` if longer, doubling on repeats up to 15 minutes. The GET retry for 5xx is
  unchanged; 429 is no longer retried by it.
- **Key isolation for other tools.** New `Hub.cmd gateway <route> --json-in` (also `node src/cli.mjs gateway ...`): JSON request
  on stdin, provider envelope on stdout, exit codes 0, 1, 2 (`not_configured`), 64, 75. The keys exist only in that child; no
  module named by the environment (`FRAME_GATEWAY_MODULE`-style) is loaded; the Hub database is not opened. Documented as the
  supported integration in `docs/INTEGRATION.md`. `src/cli.mjs` now dispatches to `src/cli-main.mjs` (the unchanged command line).
- **Default hourly cap raised to 1800 per key** (one call every 2 s on average, with the 1 s minimum spacing and one call at a time unchanged), well inside the portal's published rates. New `Hub.cmd gateway --limits` prints the effective limits as JSON (configuration only, no key use) so callers can estimate run times.
- **Settings are checked.** `directMinIntervalMs`, `maxRequestsPerHour`, `limiterStaleLockMs` (at least 5000) and `limiterMaxWaitMs` must be finite non-negative numbers; a value such as `"1s"` now stops the Hub with a clear message instead of silently switching pacing off. `gateway --limits` and the direct transport use one function, so the report is what is enforced. A longer `Retry-After` is honoured in full (up to 24 hours); only the doubling is capped at 15 minutes. A damaged or unreadable limiter state file is an error (`local_state`), as is a 429 cooldown that cannot be saved. Leftover files of the Hub's own, by exact name (`<provider>-<16 hex>.json.<12 hex>.tmp`, `.lock.<12 hex>.tmp`, `.lock.stale.<12 hex>`, takeover leftovers and `salt.<12 hex>.tmp`), are swept when older than 60 seconds; nothing else in the limiter folder is ever touched. `limiterDir` / `PATENT_RESEARCH_LIMITER_DIR` must be absolute paths (relative ones are refused).
- **Second review round.** Lock and salt files are created whole (temporary file plus hard link), and the takeover file is only deleted by its owner; a failed takeover now waits instead of spinning; the lock is refreshed just before a call; `release` retries a failed read; an empty or damaged salt file gives a clear error; a zero-length state file becomes cautious defaults (no calls left this hour with a cap, plus a 5 s cooldown) that are saved at once, so the hour starts once and runs down, and state is flushed to disk before it replaces the old; an EPO or Google token request answered with HTTP 429 now starts the limiter cooldown; tests are forced onto temporary limiter folders (each test file imports `test/setup.mjs`).
- **Final review round.** A 429 is recorded even if the lock was taken over during the call (the holder queues again, keeps the longer cooldown and returns the original result); file systems without hard links (EPERM, EISDIR, EINVAL, UNKNOWN) fall back to exclusive create, and moved-aside files are put back by rename if a link is impossible; the salt is fsynced; a holder with a live process gets one more heartbeat interval before a takeover; an EPO or Google token request answered with 429 says how long to wait and sets `retryAfterSeconds`; `limiterDir` needs a drive letter on Windows (network paths and `\\folder` are refused).
- **Review fixes.** The takeover of a stale lock is serialised by an exclusive file (before, two processes could take the same stale lock together in about 3 of 120 rounds of a 32-process test); a persistent permission error on the lock file is reported instead of "busy"; the gateway child exits when its parent disappears; stdin may start with a byte order mark; lookups by name use `Object.hasOwn`; the rejections empty-page check compares with the requested start.
- **Docs.** README, SECURITY and INTEGRATION describe the route, the limits and the USPTO portal rules (ID.me-verified key, one
  call at a time per key, 4 to 15 requests per second, at least 5 seconds after a 429, keys unused for 90 days are deleted).
- **Installer.** Robocopy in the uninstaller's folder removal and in Setup's program-file copy now runs with `/R:1 /W:1`: with
  Robocopy's default (a million retries, 30 s apart) removing a program folder that a running process had open never finished.
  Found because two installer tests hung until their timeout on Windows 11 build 26200.
- Tests: new `limiter`, `gateway-cli`, `oa-direct` suites (including tests with several real processes) and a `Hub.cmd gateway`
  installer test; `npm test` now loads `test/setup.mjs` so limiter state goes to a throwaway folder.

### Upgrading from 0.1.0

- Extract the new zip and run `Setup.cmd` again over the existing install: it replaces the program folder and `Hub.cmd` and keeps
  your data folder, `config.json` and `keys.env` (Repair does not copy new program files). No setting needs to change.
- `maxRequestsPerHour` now counts requests from all Hub processes that share the data folder, not just one process. A script that
  stayed under the old per-process count may now hit `local_limit`. The default cap is now 1800 per hour per key (was 120 per process); lower it in `config.json` if you want to be more cautious.
- Calls with the same key now take turns. A second process no longer runs in parallel; it waits (up to `limiterMaxWaitMs`).
- A 429 is returned to the caller instead of being retried by the Hub's GET retry; wait at least 5 seconds before any retry.
- A new per-user folder `%LOCALAPPDATA%\PatentResearchHub\limiter` appears (not removed by the uninstaller). It holds counters, lock files and a random salt (names are a truncated hash of the key, never the key); it is safe to
  delete while no Hub process is running.
- Patent Genius 0.1.0 needs this version for `Hub.cmd gateway`.

## 0.1.0 — 2026-11-19

First public preview release (public preview 0.1.0).

- Windows installer: `Setup.cmd` installs per user under `%LOCALAPPDATA%\Brightline\PatentResearchHub` with no administrator rights, offers Node.js LTS (required) and Python 3.12 (optional) through winget only after a yes, runs `npm ci --omit=dev` from the lockfile, and keeps a separate user-only data folder with `config.json` (BigQuery in dry-run mode) and an empty `keys.env`. It writes MCP snippets for Claude Desktop, Claude Code and Codex without editing any client configuration, and adds Check, Data folder, Documentation, Repair and Uninstall shortcuts. Repair keeps data, settings and keys; Uninstall keeps the data folder unless asked. `-DryRun` and `-SimulateMissing` preview it.
- Review fixes (installer): Uninstall from the Start Menu now works (the shortcuts no longer start inside the program folder, and the uninstaller leaves it before deleting); the data deletion you chose no longer depends on the program-folder result, and the last lines state whether each folder was deleted or kept. `Hub.cmd` is written as UTF-8 and runs under code page 65001, so folders with non-ASCII names work. Setup gives a new data folder and `keys.env` to your account only (no SYSTEM or Administrators entry), reads the access list back and stops unless only your account (or, if someone added them, SYSTEM and Administrators) has access; an existing `keys.env` is re-protected in a single step and read back, and an existing data folder is only checked (Setup warns and does not change it); it refuses a download folder and program folder that contain one another; it asks (default no) before stopping running Hub processes; it warns that a failed package download during an update leaves the Hub unusable until Setup is run again, and no longer says nothing outside the Hub's folders changed when winget installed something.
- Review fixes (reports): report tools no longer require Python. Without Python and matplotlib the report is still exported (JSON, Markdown, HTML, CSV, dataset) with a warning and no chart; the renderer is checked before any BigQuery call, the three report tools (`research_cpc_report`, `research_bigquery_cpc_report`, `research_examiner_report`) return `warnings` as the first field, no empty export folder is left after a failure, and the chart process receives no provider keys.
- Review fixes (reliability): staged originals are written to a temporary name and renamed, and a damaged staged file is replaced instead of blocking the original for good; the SQLite database waits up to 5 s for another Hub process instead of failing at once; omitted download deadlines default to 180 s for application originals (the bounded downloader and the n8n custom node), GovInfo opinion PDFs get 180 s; the model proxy no longer crashes when no models are configured.
- Documentation: 36 MCP tools; `n8nRemoteHost`, CPC scheme lookups and GovInfo opinion PDFs described accurately; Patent Genius integration; the Context Forge requirement of PatentsView intake; no retention or pruning; `--env-file` does not override existing variables; PyPI packages are version-pinned, not hash-pinned.
- Second review round: reserved Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with any case, extension or trailing dots and spaces) are refused as checkpoint session names and backup manifest names, so no folder is created that cannot be deleted later; the uninstaller also lists and removes such entries with `\\?\` paths (and `cmd.exe rd` as a last resort), deletes the marker file and the `installer` folder last so a partial removal can be run again, and tells you to delete a named folder in File Explorer if it fails. The report tools check the title and create and test-write the export folder before any BigQuery query runs, and if the export fails after a paid query the result is still returned with an `exportError` field. `taskkill` and `icacls` failures no longer surface as raw PowerShell errors (success is judged by listing the processes again and by the exit code); `Hub.cmd` restores the code page where the language prints a trailing period; old orphan `.tmp` files in the staging folder are swept; a rename that fails because another process staged the same file is accepted when the file is intact. Documentation corrected: what Repair does, what the access-list checks cover, and that a chart needs Python with matplotlib. Dependencies updated so that `npm audit --omit=dev` reports no advisories: `@modelcontextprotocol/sdk` 1.32.2, `fast-xml-parser` 5.12.1, `zod` 4.6.6 and the transitive packages in `package-lock.json` (no code changes were needed). Repair no longer prints "Program files copied". Shortcuts: Setup checks before anything is created that shortcuts can be saved in the shortcut folder (a test shortcut is made and removed) and stops with a plain message otherwise; shortcuts are saved in a plain path and moved into place, so a shortcut folder with characters outside the Windows ANSI code page (for example Japanese on a Western Windows) works, and paths stored inside shortcuts use the 8.3 short name when needed (a shortcut that cannot be made is skipped with a warning); `installer.json` is written before the shortcuts so `installer\remove.ps1` works after any later failure; Uninstall says "Data folder not present" when there is nothing to keep.
- Original documents: the size limit for USPTO application originals (reexamination requests, third-party affidavits) and GovInfo court-opinion PDFs is raised from 10 MB to 40 MB on the direct transport, the client checks and the n8n workflows alike. The bounded downloader lets application originals run for up to 180 s (was 60 s); PTAB decisions stay at 10 MB and 60 s. The n8n custom node and the portable `application-pdf-core` workflow match.
- Office Action rejections (n8n route): a provider reply without a `{response}` object (for example an HTML error page) is now a 502, not a 200; the field list `{fields:[...]}` stays a 200. The core workflow uses separate records (POST) and fields (GET) HTTP nodes with literal method, body and content type.
- n8n transport: an https gateway is accepted only on the host named in the new `n8nRemoteHost` setting (empty by default; loopback http is otherwise the only option). The base URL must be a bare origin.
- n8n build scripts: the application-pdf core build writes LF line endings; `build-live-govinfo-core.mjs --refresh-pack` re-applies the package code to an already patched core.

- BigQuery reconciliation removed from MCP (operator CLI only; explicit `--actual-bytes`, `--force-zero` to go below the estimate); `maxRequestsPerHour` per keyed provider; staged originals always use the intake directory; example examiner name replaced; trusted-config notes for dynamic module loading; `release-status` no longer fails on a fresh data directory.

- Direct transport (default): the Hub calls USPTO Open Data Portal, EPO OPS (OAuth client credentials with
  in-memory token caching), GovInfo, CourtListener and Google BigQuery itself, with credentials from environment
  variables. Same request validation and response envelopes as the n8n workflows, so tool output is identical on
  both transports. Offline-tested with mocked providers only; not verified against live providers.
- Conservative network behaviour: per-provider request pacing, timeouts, size caps, retries with backoff only for
  idempotent GET requests.
- BigQuery: dry-run estimates by default; data queries need explicit enablement, an acknowledged billing mode, a
  per-query `maximumBytesBilled` ceiling and a locally tracked monthly budget.
- CourtListener disabled by default; enabling requires acknowledging the Free Law Project allowed-use terms.
- `doctor` CLI command and `research_doctor` MCP tool report which sources are configured (names only).
- Missing credentials produce a structured `not_configured` result with the registration link.
- Reference library ships as a manifest of official URLs and SHA-256 pins with a `references-fetch` command; no
  reference PDFs are distributed.
- Optional n8n transport, workflows, build scripts and custom node moved to `extras/n8n/`.
- Optional Get Files and corpus integrations are configured explicitly and degrade with a clear message.
- Fixed: a refused BigQuery monthly reservation no longer masks its own error with "reservation not found".
