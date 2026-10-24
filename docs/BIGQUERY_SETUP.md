# Google BigQuery setup

The Hub queries two Google-hosted public tables through **your own** Google Cloud project:

- `patents-public-data.patents.publications` (Google Patents Public Datasets) for CPC publication-year trends;
- `patents-public-data.uspto_oce_pair.application_data` (a 2017 copy of USPTO PatEx) for examiner and art-unit
  outcome aggregates (see [EXAMINER_ANALYTICS.md](EXAMINER_ANALYTICS.md)).

Only fixed, parameterized SQL is ever sent. The direct transport has been tested offline only; check your first
dry run and first data query in the Google Cloud console.

## Cost

BigQuery bills by bytes scanned, not by rows returned. One 2021–2025 US G06N trend query scanned about 16.5 GiB when
the developers ran it; examiner queries against the PatEx table scan roughly 0.6 GiB. Current prices and the
monthly free allowance are on [Google's pricing page](https://cloud.google.com/bigquery/pricing). Read it before
enabling data queries. You are responsible for your project's billing.

The Hub's controls:

| Control | Default | Effect |
| --- | --- | --- |
| `googleBigQueryDryRunEnabled` | `true` | Dry runs return a byte estimate and process no data (no charge). |
| `googleBigQueryExecutionEnabled` | `false` | Data queries are refused until this is `true`. |
| `googleBigQueryBillingMode` | `disabled` | Must be `sandbox-no-billing` or `billing-enabled-capped` for data queries. |
| `googleBigQueryPerQueryMaxBytes` | 25 GiB | Every data query is preceded by a dry run; an estimate above this is refused. It is also sent as `maximumBytesBilled`, so Google rejects a query that would bill more. |
| `googleBigQueryMonthlyTrackedMaxBytes` | 256 GiB | Local calendar-month budget for this tool's queries. A reservation for the dry-run estimate is made before execution and settled after. |

The local ledger cannot see queries made in the console or by other tools. Interrupted queries stay conservatively
reserved; `bigquery-usage` lists them and `bigquery-reconcile` records the exact bytes after you check the job
history (see [PERSISTENCE.md](PERSISTENCE.md)). Reconciliation is an operator CLI step only (not an MCP tool); it requires `--actual-bytes`
and refuses a value below the dry-run estimate unless `--force-zero` is given.

**What enforces what:** the per-query ceiling is sent to Google as `maximumBytesBilled`, so Google itself rejects a query that
would bill more. The monthly cap is only a local ledger kept by this tool; it cannot see other tools or the console, and it
is not a Google-enforced budget. For a hard monthly stop use a sandbox project or a Google Cloud budget/quota.

## Recommended: a sandbox project

A [BigQuery sandbox](https://cloud.google.com/bigquery/docs/sandbox) project has no billing account, so Google
refuses work beyond the free allowance instead of charging. Keep the project detached from billing if you rely on
that.

1. Create a new Google Cloud project for this tool only (do not reuse a production project). Note its project ID.
2. Enable the BigQuery API. Do not attach a billing account if you want sandbox behaviour.
3. Create credentials, either:
   - a **service account** in that project with the role *BigQuery Job User* (lets it run queries in your
     project; the public tables need no extra data role); download a JSON key and keep it outside the install
     folder, or
   - your own user credential: `gcloud auth application-default login`, which writes an `authorized_user` file.
4. Set the environment:

   ```sh
   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json
   BIGQUERY_PROJECT_ID=your-project-id
   ```

5. Check readiness and run a free dry run:

   ```sh
   node src/cli.mjs doctor
   node src/cli.mjs bigquery-estimate --cpc G06N --from 2024 --to 2024
   node src/cli.mjs examiner-estimate --scope art-unit --art-unit 3645 --from 2012 --to 2016
   ```

   The result must show `dryRun: true`, `executedDataQuery: false` and `totalBytesBilled: "0"`.

6. Only after reviewing the estimate and pricing, enable data queries in `config.json`:

   ```json
   {
     "googleBigQueryExecutionEnabled": true,
     "googleBigQueryBillingMode": "sandbox-no-billing",
     "googleBigQueryPerQueryMaxBytes": "26843545600",
     "googleBigQueryMonthlyTrackedMaxBytes": "274877906944"
   }
   ```

   Use `billing-enabled-capped` instead if your project has billing and you accept charges up to the caps.

7. Run a report and check the usage ledger:

   ```sh
   node src/cli.mjs bigquery-report --cpc G06N --from 2021 --to 2025
   node src/cli.mjs bigquery-usage
   ```

The Hub requests the `https://www.googleapis.com/auth/bigquery` OAuth scope for service accounts and caches the
access token in memory only. The key file is read at call time and never copied.

## What a report contains

A CPC report counts **distinct US publication numbers** per publication year whose CPC codes start with the
subclass (for example `G06N`) or equal the exact symbol. It is not a count of applications filed, patent families
or inventions, and unpublished applications are absent. Each report records the table's last-modified time, the
bytes processed and billed, the cap in force and the ledger state. A successful aggregate is cached locally and
can be served again, clearly labelled, if a later identical query fails.

## n8n transport

On the optional n8n transport the same queries run in the workflows `google-bigquery*` and `examiner-bigquery*`
from `extras/n8n/workflows`, with the project ID set in each workflow's policy node (placeholder
`REPLACE_WITH_YOUR_PROJECT_ID`) and an n8n Google BigQuery OAuth2 credential.
