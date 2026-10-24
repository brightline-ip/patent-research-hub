# Official references and hosted patent access

## Reference manifest (no PDFs shipped)

`config/reference-manifest.json` lists 52 official reference documents: all MPEP chapters, appendices and front
matter, subsequent MPEP publications and guidance, the USPTO consolidated patent laws (35 USC) and patent rules
(37 CFR), and the Federal Rules of Civil Procedure. Each entry has its official URL, edition note and the SHA-256
of the version pinned when this release was prepared. The documents themselves are **not** distributed.

Fetch them from the official sites and check them against the pins:

```sh
node src/cli.mjs references-fetch                 # all 52 (spaced 1 s apart)
node src/cli.mjs references-fetch --source mpep   # one family: mpep, usc35, cfr37, frcp, guidance
node src/cli.mjs references-fetch --id usc35      # one document
```

Files land in `<dataDir>/references`. A matching hash is saved as `<id>-<sha256>.pdf` (`verified`). A different
hash usually means the publisher updated the document; it is saved as `<id>-<sha256>.candidate.pdf`
(`hash-changed`) for your review and never treated as the pinned version. A hash proves byte identity, not that
the text is current law.

When this release was prepared, the MPEP index identified the Ninth Edition, Rev. 01.2024 (published November 2024),
with later guidance listed separately; the USPTO consolidated Title 35 was dated July 18, 2025 and the patent-rule
consolidation July 20, 2026; the FRCP pamphlet was amended through December 1, 2025. The USPTO rule consolidation
is not every provision of Title 37. Verify currency with the [eCFR](https://www.ecfr.gov/current/title-37/chapter-I),
[OLRC Title 35](https://uscode.house.gov/browse/prelim@title35&edition=prelim) and the Federal Register.

## Full-text search (optional Get Files integration)

`research_reference_acquire`, `research_reference_poll` and `research_reference_search` acquire the originals into
the optional [Get Files](INTEGRATION.md) corpus, index the extracted chunks with verified chunk hashes, and search
them with deterministic literal-token matching. Every hit carries the source URL, edition, PDF page locator,
original SHA-256, chunk hash and extraction warnings. A match can be a contents page, index entry, historical
provision or cross-reference; it is not automatically the operative rule.

The first complete acquisition becomes the pin; later acquisitions are stored as candidates and never overwrite a
pin. `research_reference_pin` explicitly selects an indexed version after you review its edition and effective
dates. `config/reference-reviews.json` records a visual review that three FRCP pages are blank, tied to that exact
original hash; a different hash does not inherit it.

`config/references.json` holds the editable catalog and the three monitored indexes (MPEP, FRCP, USPTO patent
legal administration). `research_reference_check` / `references-check` compares those official index pages with
saved snapshots and reports changes; it never changes a pin. Schedule it yourself if you want regular checks.

## Callable interfaces

```sh
node src/cli.mjs references
node src/cli.mjs references-search --source mpep --query "eligibility"
node src/cli.mjs references-check
node src/cli.mjs external --source google-patents --query "G06N"
node src/cli.mjs external --source google-patents --id US11244675B2
```

MCP tools: `research_references`, `research_reference_search`, `research_reference_acquire`,
`research_reference_poll`, `research_reference_pin`, `research_reference_check`, `research_external_access`.

## Primary materials and provider analytics

- **Google Patents:** search and publication links only. Google documents CSV downloads of up to the top 1,000
  results, so an export is not an exhaustive cohort. Google metadata, translations and status labels are distinct
  from the reproduced original. [Google search help](https://support.google.com/faqs/answer/7049588?hl=en).
- **Google BigQuery:** fixed, parameterized CPC query plans, a dry-run estimator and a capped trend report in your
  own project; see [BIGQUERY_SETUP.md](BIGQUERY_SETUP.md).
- **Patent Bots:** links only. Basic statistics need a free login; its terms prohibit systematic downloading and
  scraping, so automated polling is disabled. [Terms](https://www.patentbots.com/terms).
- A faithful copy of a judicial opinion is primary material whoever hosts it; a vendor's summary, prediction or
  derived metric is not the original authority.

Local reference files are ordinary files; no application encryption or citator is included.
