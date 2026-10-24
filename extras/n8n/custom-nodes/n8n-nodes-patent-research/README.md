# Bounded USPTO original node

This credential-owning n8n node replaces buffered original HTTP requests in
`n8n/application-pdf-core.json` and `n8n/ptab-files-core.json`. Version 0.2.0
adds PTAB trial and appeal decisions. The reviewed package is installed in the
local n8n persistent node volume, and the PTAB core and authenticated gateway
were published on September 9, 2026.

The node accepts an application/document or PTAB proceeding identity, not an
arbitrary URL. It uses the existing encrypted `httpHeaderAuth` credential only
on the initial USPTO API request. One exact signed-document redirect is allowed
without forwarding that credential. It enforces a 10 MiB streaming cap,
expected MIME and file signature, public pinned IPv4 DNS, a total deadline, and
two concurrent downloads per process. It outputs bounded base64 plus unsigned
provenance; it does not normalize files. The Workbench shared-intake adapter
sends staged originals to Get Files.

The live PTAB signed response uses `binary/octet-stream`. The node accepts that
provider MIME only when a PDF is expected and only after the exact signed path is
validated; the bytes must still have a PDF signature, and output is normalized
to `application/pdf`.

## Deployment evidence

The full 70-test suite passes. `data/original-node-verification.json` records the
disposable n8n 2.37.10 engine check with no network or live volume. The protected
n8n backup and disconnected restore test completed before installation. The core
was published before the gateway, an unauthenticated call returned HTTP 403, and
the bounded public smoke returned the expected 936,888-byte PDF with SHA-256
`44d62ddfdf845ee790481ff34e422c4348b1101ff53c20d1778ee81d37604dd0`.
The credential-free deployment receipt is
`data/ptab-streaming-deployment-20260909.json`.

For another n8n installation, preserve the current workflows and runtime for
rollback, install this package before importing workflows that reference it,
bind the destination's encrypted USPTO credential, publish the callable core
before its gateway, and run a bounded public-document check.

These limits cover this original-download node, not every other HTTP connector.
The per-process concurrency cap is not a distributed rate limiter.
