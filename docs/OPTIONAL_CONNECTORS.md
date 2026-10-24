# Keyed provider connectors

Each keyed provider is optional. Without its credential a tool returns `not_configured` with the signup link;
`node src/cli.mjs doctor` lists what is missing. Credentials are environment variables only: never put them in
`config.json`, tool arguments, checkpoints or chat.

| Provider | Variables | Register | Notes |
| --- | --- | --- | --- |
| USPTO Open Data Portal | `USPTO_API_KEY` | [Getting started](https://data.uspto.gov/apis/getting-started) | Sent as `X-API-KEY` to `api.uspto.gov` only. Original downloads follow one signed redirect without the key. |
| EPO OPS | `EPO_OPS_CONSUMER_KEY`, `EPO_OPS_CONSUMER_SECRET` | [Developer registration](https://developers.epo.org/user/register) | Register as a non-paying user, wait for approval, create an application under *My Apps*. The Hub uses the OAuth client-credentials grant against `https://ops.epo.org/3.2/auth/accesstoken`, caches the token (about 20 minutes) in memory and renews it once after a 401. |
| GovInfo | `GOVINFO_API_KEY` | [API signup](https://www.govinfo.gov/api-signup) | Sent as `X-Api-Key`. Fixed `USCOURTS` search with relevance sort, and opinion PDFs by package and granule id. |
| CourtListener | `COURTLISTENER_TOKEN` and config `courtlistenerEnabled`, `courtlistenerInternalUseAllowed` | [REST API docs](https://wiki.free.law/c/courtlistener/help/api/rest/v4/rest-api-v47) | Disabled by default. Sent as `Authorization: Token …`. Opinion search with `q`, `type=o` and the provider cursor; fixed 20-result pages, so the Hub requires `limit: 20`. |
| Google BigQuery | `GOOGLE_APPLICATION_CREDENTIALS`, `BIGQUERY_PROJECT_ID` | [Sandbox](https://cloud.google.com/bigquery/docs/sandbox) | See [BIGQUERY_SETUP.md](BIGQUERY_SETUP.md). |

## Terms you accept by enabling a provider

- **CourtListener / Free Law Project.** The [allowed API usage policy](https://free.law/membership/allowed-api-usage/)
  is membership-based. Solo practitioners and small firms are generally welcome; larger organizations, shared
  credentials and commercial products may need Free Law Project's agreement. Set
  `courtlistenerInternalUseAllowed` to `true` only after reading it, and each person should use their own token.
- **EPO OPS.** The [OPS terms](https://www.epo.org/en/service-support/ordering/terms-and-conditions/ops-terms-and-conditions)
  and [fair-use charter](https://www.epo.org/en/service-support/ordering/fair-use) set a weekly volume for
  non-paying users and throttle heavy use.
- **USPTO and GovInfo.** Keys are per user and rate limited by the provider.

## Request behaviour

The direct transport reuses the n8n workflows' validation (`src/workflow-validation.mjs`): only the configured
provider URL and path, bounded query fields, a fixed GovInfo body and sort, and EPO paths limited to one EPODOC
publication or one CPC symbol. Provider non-success statuses are preserved, so an authentication or quota error is
reported as an error, never as zero results. Requests to one provider are spaced by `directMinIntervalMs`
(GovInfo 3.6 s, others 1 s by default); idempotent GET requests are retried at most twice on 429/5xx with
`Retry-After` or exponential backoff capped at 5 s; POST requests are never retried.

These connectors have been exercised offline with mocked responses only in this release.

## n8n transport

With `transport: "n8n"` the same requests run in the `*-core` workflows in `extras/n8n/workflows`, with
credentials held in named n8n connections instead of environment variables. See
[extras/n8n/README.md](../extras/n8n/README.md).

## Official documentation

- [GovInfo Developer Hub](https://www.govinfo.gov/developers)
- [CourtListener API usage limits](https://wiki.free.law/c/courtlistener/help/api/rest/v4/api-usage)
- [EPO OPS](https://www.epo.org/en/searching-for-patents/data/web-services/ops)
- [USPTO Open Data Portal](https://data.uspto.gov/apis/getting-started)
