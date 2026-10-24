# Changelog

## Unreleased — security review fixes

- BigQuery reconciliation removed from MCP (operator CLI only; explicit `--actual-bytes`, `--force-zero` to go below the estimate); `maxRequestsPerHour` per keyed provider; staged originals always use the intake directory; example examiner name replaced; trusted-config notes for dynamic module loading; `release-status` no longer fails on a fresh data directory.

## 0.1.0 — 2026-10-23

First public preview.

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
