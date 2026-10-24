# PTAB original decision PDFs

The Hub can fetch the original PDF behind a saved PTAB trial or appeal decision record, verify it, and stage it for
an optional corpus. The same bounded downloader (`src/bounded-download.cjs`) runs on the direct transport and inside
the optional n8n custom node.

## Data flow

1. Call `research_query` with `source: ptab-trials` or `source: ptab-appeals` and select a returned record id.
2. Call `research_archive` with that id. The Hub checks that the stored original URL matches the trial or appeal
   number and document identifier; a caller cannot supply an arbitrary authenticated URL.
3. The downloader builds the official API URL from those identity fields and sends `USPTO_API_KEY` to
   `api.uspto.gov` only. USPTO answers with a signed redirect; the downloader accepts only a redirect to the exact
   same document under `https://data.uspto.gov/ptab-files/` with the expected signature parameters, and follows it
   **without** the API key. The signed link never leaves the downloader or enters any record.
4. While streaming it caps the body at 10 MiB, pins public IPv4 DNS for the provider hosts, applies one 60-second
   deadline, allows two concurrent downloads per process, and checks MIME type, length and the `%PDF-` signature.
5. The Hub re-checks identity, base64 encoding, byte count and signature, computes SHA-256 and stages the file as
   `<corpusIntakeRoot>/patent-research/<sha256>.pdf` (default `<dataDir>/intake`).
6. With the optional Get Files integration configured, the staged file is submitted with its official source URL,
   record id, expected hash and tags. Poll `research_jobs`; then `research_record` links the job, original, corpus
   document and extraction warnings, and `research_read_source` reads page-located chunks. Without Get Files,
   `research_archive` reports `not_configured` (the download is not attempted).

Repeating `research_archive` for the same source snapshot reuses its job. `retry: true` requeues an existing failed
corpus job; it does not force a fresh provider download.

An original, its extracted text, the text actually read, and legal authority are different states. An acquired
document may need OCR. Nothing is marked read or legally verified because extraction completed.

## CLI

```sh
node src/cli.mjs query --source ptab-trials --query "trialNumber:IPR2025-00673" --limit 5
node src/cli.mjs archive --id RECORD_ID
node src/cli.mjs jobs --id JOB_ID
node src/cli.mjs record --id RECORD_ID
node src/cli.mjs read-source --id DOCUMENT_SHA256 --offset 0
```

Set `ptabOriginalsEnabled` to `false` in `config.json` to disable original downloads.

## n8n transport

On the n8n transport the download runs in `patent-research-ptab-files-core` with the `USPTO Bounded Original` custom
node from `extras/n8n/custom-nodes`. Trial input is `{"trialNumber":"IPR2025-00673","documentIdentifier":"171365535"}`;
appeal input is `{"appealNumber":"2025003334","documentIdentifier":"<uuid>"}`. Both return
`{status, url, contentType, bytes, base64}`, the same envelope as the direct transport.

When the developers verified the n8n path in September 2026, USPTO labelled signed PDFs `binary/octet-stream`; that
MIME type is accepted only when the bytes start with `%PDF-`. The direct transport has not been run against USPTO.
