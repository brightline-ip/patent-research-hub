# Examiner and art-unit analytics

The examiner tools separate current identity lookup from historical outcome calculation.

1. `research_examiner_lookup` sends one bounded name-fragment query to the official USPTO Patent File Wrapper API. Use it to confirm the exact examiner name and current art-unit examples. Its provider total and returned-page counts are search metadata, not caseload statistics.
2. `research_examiner_estimate` dry-runs fixed, named-parameter SQL against `patents-public-data.uspto_oce_pair.application_data`. It returns byte metadata only and must prove zero billed bytes and no data execution.
3. `research_examiner_report` (only when BigQuery execution is enabled in config; see [BIGQUERY_SETUP.md](BIGQUERY_SETUP.md)) runs the same fixed aggregate under the per-query byte ceiling and the local monthly ledger, saves the validated aggregate locally, then exports JSON, CSV, Markdown and HTML, plus an SVG and PNG chart only when Python with matplotlib is available (otherwise the result carries a warning and no chart).
4. `research_examiner_source_status` makes no provider call. It reports the stable contract version, hosted-query configuration, locally persisted aggregate count, and optional bulk-download sizes.

The normal strategy is query on demand. It does **not** download PatEx application records. Every successful aggregate is stored in `data/research.sqlite` under a deterministic key made from the contract version, fixed table identity, scope, exact examiner or art unit, and year range. The stored payload has a SHA-256 integrity value that is checked when read. If the hosted preflight or data query later fails, an exact prior aggregate can be returned with `delivery.mode = local-validated-aggregate-cache`, its saved time, payload hash, and the current provider error. A scope or year range that has never been queried still requires the hosted provider.

The official USPTO page lists the complete 2022 CSV release as **12.1 GB** and its `application_data` CSV as **887 MB**. Neither is required for this mode. A local bulk snapshot remains an optional future choice when newer-than-2017 coverage or offline queries for arbitrary examiners justify the download and local database space. The tool does not represent a cached 2017 aggregate as current 2022 data.

The historical query includes only records where `application_type = REGULAR`, `invention_subject_matter = UTL`, and `disposal_type` is `ISS` or `ABN`. It deduplicates by application number and groups an issue by patent issue year or an abandonment by abandonment year. The reported issued share is `issued / (issued + abandoned)` for those observed PatEx outcomes. It is **not** the USPTO allowance rate: pending applications are omitted and RCE abandonments are not separate disposals.

Google's hosted mirror is old. The live Tables API reported 9,817,693 rows, 2,284,475,821 bytes, and modification time `2017-10-12T18:57:40.219Z`. Its old schema stores examiner names in separate last/first/middle fields and dates as strings. The tool verifies that exact table identity and schema before each data query, rebuilds the exact comparison name inside fixed SQL, parses supported date formats, and caps valid dates at the verified table-modification date. The live quality check excluded zero filing-date, two issue-date, and ten abandonment-date values outside 1900 through that snapshot date.

When the developers ran it through the original n8n deployment, a sample examiner (name replaced here by the placeholder `EXAMPLE, ALEX Q`) resolved in current ODP records with art unit `3645`, then queried 2012–2016 historical PatEx outcomes. It returned:

| Year | Issued | Abandoned | Total observed outcomes | Issued share |
| --- | ---: | ---: | ---: | ---: |
| 2012 | 105 | 20 | 125 | 84.00% |
| 2013 | 108 | 14 | 122 | 88.52% |
| 2014 | 114 | 13 | 127 | 89.76% |
| 2015 | 91 | 9 | 100 | 91.00% |
| 2016 | 13 | 0 | 13 | 100.00% |

The 2016 row is visibly incomplete in this snapshot and should not be compared as a mature annual cohort. The table's valid maximum filing date was `2016-02-24`; its valid maximum disposal date was `2016-09-27`. Exact-name collisions can combine people, and the current ODP assignment can differ from the historical disposition-time assignment. Use the newest official USPTO PatEx release when outcomes after this snapshot matter.

CLI examples:

```sh
node src/cli.mjs examiner-lookup --examiner Example --limit 10
node src/cli.mjs examiner-status
node src/cli.mjs examiner-estimate --scope examiner --examiner "EXAMPLE, ALEX Q" --from 2012 --to 2016
node src/cli.mjs examiner-report --scope art-unit --art-unit 3645 --from 2012 --to 2016
```

On the optional n8n transport the same steps run in these workflows (`extras/n8n/workflows`):

| Workflow ID | Purpose |
| --- | --- |
| `patent-research-examiner-bigquery-core` | Metadata-verified dry-run estimator |
| `patent-research-examiner-bigquery-query-core` | Metadata-verified capped historical outcome aggregate |
| `patent-research-examiner-bigquery` | Authenticated local dry-run gateway |
| `patent-research-examiner-bigquery-query` | Authenticated local report-data gateway |

Portable workflow JSON contains no provider credential value; bind your own n8n BigQuery credential when deploying. Arbitrary SQL, manual data-query triggers, PatentBots scraping, and automatic vendor polling are absent.

Primary documentation: [USPTO PatEx](https://www.uspto.gov/ip-policy/economic-research/research-datasets/patent-examination-research-dataset-public-pair), [USPTO Patent File Wrapper](https://data.uspto.gov/patent-file-wrapper/search), and [USPTO allowance-rate definitions](https://www.uspto.gov/dashboard/patents/production-unexamined-filing.html). The hosted-table inventory is documented by Google's archived [patents-public-data repository](https://github.com/google/patents-public-data/blob/master/tables/index.md).
