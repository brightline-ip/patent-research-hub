# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.2.x (public preview) | Yes |
| 0.1.x | Upgrade to 0.2.x (adds the cross-process limiter and the key-isolating `gateway` command) |

## Reporting a vulnerability

Please report security issues privately through **GitHub's private security advisory** feature on this repository
("Security" tab, "Report a vulnerability"). Do not open a public issue for a vulnerability, and do not include real
credentials, client material or private data in a report. We aim to acknowledge reports within a few working days.

## What the software trusts

- **Your environment and configuration.** Provider credentials are taken from environment variables; settings from
  `config.json` (or `PATENT_RESEARCH_CONFIG`). Anyone who can change those, or the install folder, controls the tool.
- **Fixed provider endpoints over HTTPS.** Requests go only to built-in provider hosts and paths (USPTO, EPO OPS,
  GovInfo, CourtListener, Google OAuth/BigQuery, and the official USPTO, Federal Circuit and court-rules pages).
  Caller input cannot choose a host, a path outside the fixed ones, or SQL text. Redirects are refused except the
  single identity-checked USPTO signed-download redirect, which is followed without the API key.
- **Nothing in retrieved content.** Provider responses, PDFs and web pages are treated as untrusted data: they are
  size-capped, schema-checked and never executed or followed as instructions.
- **Optional integrations you configure.** A Get Files client module or corpus client named in configuration is
  imported and run with your user rights. The optional n8n transport must be on a loopback address, unless you opt in to one remote https host by naming it exactly in `n8nRemoteHost` (empty by default; the base URL must be a bare `https://<that host>` origin and the gateway bearer token then crosses the network, so use it only for a host you control).
- **Trusted configuration only: dynamic module loading.** `getFilesClientModule` / `RESEARCH_GET_FILES_CLIENT` and
  `corpusClientModule` / `RESEARCH_CORPUS_CLIENT` are imported as JavaScript with full user rights, and the path is not
  confined to the install folder (Get Files normally lives elsewhere). Set them only in `config.json` or an environment you
  control; never from tool arguments, shared config, or a folder other people can write to. The same applies to
  `PG_HUB_ROOT`-style settings in tools that load this Hub.
- **Local limits are not provider enforcement.** `maxRequestsPerHour` (default 1800 per keyed provider and key) and
  `directMinIntervalMs` are local safeguards shared by the Hub processes that use one data folder (state in `<dataDir>/limiter`;
  it holds a salted hash of the key, never the key). The one-call-at-a-time lock is advisory: it does not stop another program
  or computer using the same key, and a process suspended for longer than `limiterStaleLockMs` can lose its lock. The BigQuery per-query ceiling is sent to Google as
  `maximumBytesBilled` and enforced by Google; the monthly cap is a local ledger only and cannot see other tools or the
  console. Reconciling an interrupted BigQuery reservation is an operator-only CLI command (`bigquery-reconcile`), not an MCP
  tool, requires explicit `--actual-bytes`, and refuses values below the dry-run estimate without `--force-zero`.
- **USPTO key rules.** The Open Data Portal requires an ID.me-verified USPTO.gov account, one key per account and no sharing;
  it blocks concurrent calls with one key, publishes a rate of about 4 to 15 requests per second, asks for a wait of at least
  5 seconds after an HTTP 429 before any automatic retry, and deletes a key that has not been used for 90 days (portal pages
  read 2026-11-20; the portal can change them). The Hub follows the first three itself (see the README); you are responsible
  for the account, the key and any later change in the rules.
- **Key isolation for other tools (`gateway` command).** A tool that needs provider access starts `Hub.cmd gateway <route>
  --json-in` as a child process: the keys from `keys.env` exist only in that child's environment, the request comes on stdin
  (at most 256 KB, one JSON object), the answer goes to stdout, and the child never prints a key. The command accepts only
  a fixed list of source and document routes (no BigQuery, no n8n-only routes), loads no module named by the environment
  (`FRAME_GATEWAY_MODULE`-style test overrides are ignored and reported on stderr), does not open the Hub database, and
  validates every request with the same rules as the in-process gateway. Anyone who can start the Hub as your user can use
  your keys through it, exactly as they could by running `Hub.cmd` or reading `keys.env`; protect the account and the
  data folder. `gateway --limits` prints configured limits only and uses no key. A caller that has keys loaded itself gains nothing from this command.
- **n8n workflows.** Webhook IDs in the shipped workflow JSON are regenerated by n8n when you import them; the gateways are
  protected by the bearer file, not by an unguessable URL.

## Credentials

Credentials are sent only to their own provider, kept in memory (EPO and Google OAuth tokens included) and never
written to the database, exports, checkpoints or logs. `doctor` reports only whether a variable is set. Errors that
look like they contain a secret are suppressed. Do not paste credentials into tool arguments or chat.

## Local-only data

All saved records, snapshots, ledgers, checkpoints, reports, staged originals and reference PDFs stay in local
folders (`data/` and `exports/` by default, or `PATENT_RESEARCH_DATA_DIR` / `PATENT_RESEARCH_EXPORTS_DIR`). The
software has no telemetry and sends nothing anywhere except the provider requests you ask for. There is no
application-level encryption of local files; protect them with your operating system's access controls, and do not
send client-confidential material to a provider unless your obligations permit it.

## Windows installer (Setup.cmd)

- Installs per user with no administrator rights: program files in `%LOCALAPPDATA%\Brightline\PatentResearchHub`, data in
  a separate `%LOCALAPPDATA%\Brightline\PatentResearchHub-Data`. It installs no service, scheduled task or background process.
- Node.js and Python are installed through winget only after an explicit yes; no command-line flag approves it.
  npm packages come from `package-lock.json` with `npm ci --omit=dev --ignore-scripts` (exact versions and the lockfile's
  integrity hashes). The optional chart packages come from PyPI, version-pinned in `requirements.txt`, wheels only; they
  are not hash-pinned, so a compromised package index or account could serve different files under a pinned version.
- Setup never asks for or prints a key. It creates an empty `keys.env` in the data folder and restricts it, and the data
  folder, to your account only (no SYSTEM or Administrators entry is added) before writing anything into them, then reads each
  access list back and stops if inheritance is still on or any account other than yours (SYSTEM and Administrators are
  tolerated if someone added them) can access it. An existing `keys.env` gets its list set in a single step and read back. An
  existing data folder is only checked: if it is not private to your account Setup warns and does not change it. The `Hub.cmd` wrapper, the Check shortcut and the MCP
  snippets load it with Node's `--env-file-if-exists`; keys then reach the Hub as environment variables, as before.
  Any program running as your Windows account can read the file. A variable already set in your Windows environment
  takes precedence over `keys.env` (Node's `--env-file` never overrides existing variables).
- Setup refuses FAT/exFAT and network folders, paths containing any of `" % ! & , ; = ^`, over-long paths, overlapping program
  and data folders, and non-empty folders it did not create. Marker files limit the uninstaller to folders Setup created;
  it unlinks junctions without following them, stops only Hub processes whose command line or executable is inside this
  program folder (and, during Setup or Repair, only after you answer yes; the default is no), and keeps the data folder
  unless you choose `-RemoveData` or answer yes. Its final lines state whether each folder was deleted or kept.
- Setup edits no MCP client configuration.
