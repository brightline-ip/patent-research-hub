# Free and low-cost patent sources

Checked September 2026 by the developers. Provider terms and free tiers change; none of these is a promise of
unlimited or permanent free automated access. Check each provider's current terms before relying on it.

| Source | Free access | How the Hub uses it |
| --- | --- | --- |
| Federal Circuit, PTAB and USPTO official pages | Public web pages and feeds | Keyless `refresh` of the Federal Circuit RSS feed and official indexes. Recent entries and visible links only, not an archive. |
| USPTO Open Data Portal | Free API key | File-wrapper search, PTAB trial and appeal decisions, document lists and original PDFs (`USPTO_API_KEY`). |
| Google Patents website | Free search and document viewing | Search and publication **links** only (`research_external_access`). No results API. CSV export from the site is capped at the top 1,000 results. |
| Google-hosted BigQuery public data | Monthly free query allowance under Google's current rules; a no-billing sandbox is available | Dry-run estimates and capped CPC trend and PatEx aggregates in your own project. See [BIGQUERY_SETUP.md](BIGQUERY_SETUP.md). |
| USPTO PatEx | Official bulk releases are free; Google's BigQuery copy gives hosted query access | Fixed historical examiner/art-unit outcome aggregates against the hosted copy (last modified 2017). The official 2022 release lists 887 MB for `application_data` and 12.1 GB for the complete CSV set; neither download is needed for hosted queries. |
| EPO Open Patent Services | Registered non-paying use up to a weekly volume under the EPO fair-use charter | Bibliographic lookup (CPC scheme lookups exist only as a module function, `src/epo-cpc.mjs`) (`EPO_OPS_CONSUMER_KEY`/`SECRET`). Not an unrestricted analytics service. |
| GovInfo | Free api.data.gov key | USCOURTS opinion search and PDFs (`GOVINFO_API_KEY`). Selected courts and years only. |
| CourtListener | Free account token, rate limited; membership-based allowed-use policy | Opinion search, **off by default** until you acknowledge the Free Law Project terms in config. |
| PatentsView | Free annualized bulk files | You download and prepare a cohort locally; see [PATENTSVIEW.md](PATENTSVIEW.md). |
| WIPO PATENTSCOPE / IP Statistics | Free web search; free account for larger exports | Links and instructions only; WIPO prohibits robots and bulk downloads. See [WIPO_ACCESS.md](WIPO_ACCESS.md). |
| FreePatentsOnline | Free account features | Links only. A commercial API exists; no free API entitlement is assumed. |
| Patent Bots | Basic statistics with a free login | Links only. Its terms prohibit systematic downloading. |

BigQuery's free allowance measures bytes scanned, not searches. A single CPC trend query can scan tens of GiB. The
Hub's per-query ceiling and monthly ledger are described in [BIGQUERY_SETUP.md](BIGQUERY_SETUP.md); the ledger only
sees this tool's queries.

A faithful copy of a patent hosted by a third party is still a primary document, but vendor metadata, analytics,
translations and legal-status annotations need their own provenance. Verify against the issuing office.

Sources:

- [Google BigQuery pricing](https://cloud.google.com/bigquery/pricing) and [sandbox](https://cloud.google.com/bigquery/docs/sandbox)
- [Google public datasets](https://docs.cloud.google.com/bigquery/public-data)
- [USPTO Patent Examination Research Dataset](https://www.uspto.gov/ip-policy/economic-research/research-datasets/patent-examination-research-dataset-public-pair)
- [EPO Open Patent Services](https://www.epo.org/en/searching-for-patents/data/web-services/ops) and [fair-use charter](https://www.epo.org/en/service-support/ordering/fair-use)
- [GovInfo API](https://github.com/usgpo/api)
- [CourtListener allowed API usage](https://free.law/membership/allowed-api-usage/)
- [WIPO PATENTSCOPE FAQ](https://www.wipo.int/en/web/patentscope/faqs_patentscope)
- [FreePatentsOnline search](https://www.freepatentsonline.com/search.html)
- [Patent Bots terms](https://www.patentbots.com/terms)
