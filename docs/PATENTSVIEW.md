# PatentsView landscape research

PatentsView is a secondary research-data view alongside the existing USPTO Patent File Wrapper connector. It does not replace official application records, document downloads, or legal-status research.

## What the first cohort supports

The developers' first cohort was the official annualized **2025 grant cohort**, released June 10, 2026. No PatentsView data ships with the Hub; you download and prepare a cohort yourself.

- Find patents associated with an assignee name or inventor name/identifier.
- Filter by broad CPC section or WIPO technology field.
- Count distinct patent numbers, not patent-assignee rows.
- Reuse the local snapshot through CLI, MCP, or an editable n8n workflow without model calls, paid APIs, CRM writes, or outreach.

The annualized source contains disambiguated assignee **names**, not stable organization identifiers. These names are observations, not current ownership conclusions. Inventor fields contain at most the first ten inventors. CPC section `G` is supported; a detailed query such as `G06N` must use a source with finer classifications. WIPO sector filtering refers to the first listed sector, not every sector. A single grant year is not an all-history landscape or a count of patent families.

## Intake and provenance

1. Download the exact official archive from the [PVANNUAL catalog](https://data.uspto.gov/bulkdata/datasets/pvannual) (signed-in ODP access). This is a manual acquisition, not an automated refresh.
2. Check archive hash, bounded ZIP member, actual schema and grant year.
3. Produce bounded deterministic JSONL projections with source hashes and row coverage. Gender-attribution fields are not used by the analytical index. The original ZIP remains authoritative.
4. Submit **every** projected chunk to the optional corpus integration (`RESEARCH_CORPUS_CLIENT`, for example Get Files). Preserve original and normalized hashes, job IDs, extractor version and warnings. No LLM enrichment is involved.
5. Import only after all corresponding live corpus receipts report successful, hash-matched normalization. Build a separate SQLite snapshot before changing the active pointer. Earlier snapshots remain available.

Intake is strict about the normalizer: each chunk's corpus document must report an extractor that starts with `Context Forge /` and preserve non-whitespace characters (checked in `src/patentsview-intake.mjs`), and the import step requires the receipt's normalizer to be `source-corpus/context-forge` (`src/patentsview.mjs`). A corpus that normalizes with something else is refused, so use Get Files with Context Forge as its normalizer.

The normalized text is for reuse and source context. Structured queries parse the exact hash-bound projection, not the normalizer's prose rendering. A successful normalization job is not independent verification of the source's assertions.

## Use

From the install directory (PatentsView preparation needs Python 3; set `RESEARCH_PYTHON` if it is not on PATH):

```sh
node src/cli.mjs patentsview-prepare --file ORIGINAL.zip --from 2025 --manifest PREPARED_DIR --id EXPECTED_ZIP_SHA256
node src/cli.mjs patentsview-intake --manifest PREPARED_DIR/manifest.json
node src/cli.mjs patentsview-install --manifest PREPARED_DIR/manifest.json
node src/cli.mjs patentsview-status
node src/cli.mjs patentsview-query --query robotics --limit 20
node src/cli.mjs patentsview-query --cpc H --limit 20
```

The prepared directory must be inside `<dataDir>/intake/patentsview` (or `<corpusIntakeRoot>/patentsview`); intake refuses manifests elsewhere. `patentsview-intake` and `patentsview-install` need the optional corpus client.


For combined filters, `patentsview-query --file query.json` accepts an object such as:

```json
{"assignee":"robotics","cpcSection":"G","limit":20}
```

Fresh MCP sessions expose `research_patentsview_status` and `research_patentsview_landscape`. They are read-only. Administrative archive preparation and corpus intake are deliberately not exposed as arbitrary-path MCP tools.

The optional n8n workflow `extras/n8n/workflows/patentsview-landscape.json` is an editable form and callable subworkflow built for the developers' own batch-coordinator service (mTLS bridge). It is included as an example and does not work without such a service. The query handler accepts no SQL, database path, credential or arbitrary URL.

## Refresh and recovery

Keep the existing snapshot active if acquisition, schema checking, normalization or import fails. Resume corpus intake using its existing idempotency keys rather than duplicating work. Never silently substitute a different year, a partial sample, or Google-hosted data for a requested PatentsView cohort.

New releases require renewed catalog/schema review. The catalog workflow is metadata-only; it does not transfer ZIP files through a JSON webhook. Automatic authenticated bulk refresh remains separate from local cohort queries until its bounded binary-download path is tested.
