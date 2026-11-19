# Persistent research sources and recovery

The legal research tool keeps stable callable contracts while source access and storage remain replaceable implementation details. An MCP client, another agent, the CLI, or an n8n workflow can supply the same documented inputs. Replacing the conversational interface does not change those inputs.

## Persistence matrix

| Capability | Normal source | Persistent local unit | Provider-outage behavior |
| --- | --- | --- | --- |
| MPEP, Title 35/rules, FRCP and guidance | Official originals fetched by `references-fetch` (hash-checked) or acquired through the optional Get Files integration | Immutable originals, normalized chunks, source hashes and an explicitly selected version | Pinned versions remain searchable; monitoring never changes a pin automatically |
| Federal Circuit, PTAB and other source metadata | Official feeds, indexes and bounded APIs | Immutable response snapshots and normalized record metadata | Previously retrieved records remain searchable; a new search still needs its provider |
| Opinion and patent originals | Official or documented public file URL | Original file plus corpus manifest and extraction warnings | Acquired originals remain readable locally |
| CPC publication trends | Fixed Google BigQuery aggregate | Exact CPC/year result, table timestamp, method, execution metadata and payload SHA-256 | An exact prior query returns as `local-validated-aggregate-cache`; a new query needs BigQuery |
| Examiner and art-unit outcomes | Live USPTO identity lookup plus fixed hosted PatEx aggregate | Exact scope/year result, table timestamp, method, execution metadata and payload SHA-256 | An exact prior query returns as `local-validated-aggregate-cache`; a new query needs the hosted source |
| Research sessions and reports | Local tool operations | Checkpoints, report metadata and exported evidence packets | Local material remains available offline |

The aggregate cache contains only validated result rows and provenance. It does not contain the Google patent publication table, PatEx application records, n8n credentials or model credentials. A cached result is never relabeled as a fresh result. Its delivery object records the cache time, original source snapshot, payload hash, whether the provider was attempted, and any provider error.

## Status and backup commands

```sh
node src/cli.mjs bigquery-status
node src/cli.mjs examiner-status
node src/cli.mjs backup
node src/cli.mjs restore-stage --manifest BACKUP.manifest.json
```

MCP callers use `research_bigquery_source_status`, `research_examiner_source_status`, `research_state_backup`, and `research_state_restore_stage`.

`backup` first runs SQLite `integrity_check`, creates a consistent timestamped database snapshot with `VACUUM INTO`, verifies the new database, then writes a SHA-256 manifest beside it under `<dataDir>/backups/`. Backups are retained until you remove them; the command does not delete earlier snapshots. The manifest records a portable database filename, public-data table counts and the backup boundary. `release-status` reopens the newest database and rechecks its size, SHA-256 and SQLite integrity instead of trusting the receipt.

`restore-stage` accepts only a manifest filename in `<dataDir>/backups/`. It verifies the receipt and source database, copies it with no-overwrite semantics to `<dataDir>/recovery/`, then verifies the copy and writes a receipt marked `activated: false`. It never changes `research.sqlite` while the service is open. To activate a staged recovery, stop every Hub/MCP/CLI process, preserve the current `research.sqlite`, `research.sqlite-wal` and `research.sqlite-shm` together for rollback, replace the active database with the staged copy while no writer is running, remove no backup, start one process, run `PRAGMA integrity_check` through a fresh backup or `release-status`, and compare the recorded table counts before allowing writes. This final switchover is an operator maintenance action because it replaces active state.

Interrupted BigQuery calls remain conservatively charged in the local monthly ledger. `bigquery-usage` and `research_bigquery_usage` list reservations older than one hour under `needsReconciliation`. After checking Google Cloud job history for the same time and fixed query parameters, reconcile only the exact processed/billed byte value with the operator CLI command `bigquery-reconcile --id ID --actual-bytes BYTES --evidence "..."`, and record concise evidence without credentials. `--actual-bytes` is mandatory, and a value below the reservation's dry-run estimate is refused unless `--force-zero` is also given (use it only when the provider job history shows the query never ran or billed less). Reconciliation is deliberately not an MCP tool, so an agent cannot release tracked bytes. The tool never expires or releases a reservation automatically because a provider query may have completed before the local process stopped.

The database backup does not include source-corpus originals, exported reports, provider datasets, or encrypted n8n credentials. Those have their own storage locations. Provider credentials live in your environment (or, on the n8n transport, in n8n's encrypted credential store) and are never part of a backup.

## Retention

The Hub never prunes anything. Response snapshots and records in `research.sqlite`, backups, recovery copies, checkpoints, staged originals, reference PDFs and exported reports are kept until you delete them. Only whole files (backups, checkpoints, exports) are safe to delete by hand; there is no command that trims rows or snapshots inside the database. Plan for the data folder to grow, and check its size from time to time.

## Source updates

Official reference monitoring identifies candidates and preserves the selected version until a reviewed replacement is explicitly pinned. Hosted analytics query current provider tables when available and overwrite only the deterministic cache entry for the exact contract/input combination after table identity, response schema, row bounds and byte controls pass. The prior aggregate remains represented in completed reports and state backups.

Bulk PatEx is optional. The official 2022 page lists `application_data` at 887 MB and the complete CSV release at 12.1 GB. A future bulk-source upgrade should use an immutable original, checksum and schema validation, then activate the prepared version atomically. Normal examiner calls do not depend on that download.
