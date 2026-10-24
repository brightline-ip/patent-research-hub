# Optional n8n transport

The Hub was first built with a loopback [n8n](https://n8n.io) instance holding every provider credential. That mode
remains available for people who already run n8n and prefer credentials in its encrypted store. Most users should
use the default direct transport instead; nothing in this folder is needed for it.

## Contents

| Path | What it is |
| --- | --- |
| `workflows/*-core.json` | Callable source subworkflows (validation, provider HTTP request, response packaging). |
| `workflows/<name>.json` | Authenticated webhook gateways (`/webhook/patent-research-<route>`) that call the cores. |
| `deployment/*.json` | Bundles of the same workflows for import. |
| `custom-nodes/n8n-nodes-patent-research` | The `USPTO Bounded Original` node used by `ptab-files-core` and `application-pdf-core`. Its downloader is identical to `src/bounded-download.cjs` (checked by `npm test`). |
| `scripts/` | Generators that rebuild the workflow files from the tested code in `src/` (run from the install folder, for example `node extras/n8n/scripts/build-original-workflows.mjs`). |

Placeholders to replace before use: every credential reference is `REPLACE_WITH_*_CREDENTIAL_ID` with a neutral name
(for example `USPTO ODP API Key`), and the BigQuery policy nodes use project `REPLACE_WITH_YOUR_PROJECT_ID`, which the
workflows refuse until set. Workflows are exported inactive and keep no execution data.

## Use

1. Run n8n on `127.0.0.1` only. The Hub refuses a non-loopback or credential-bearing `n8nBaseUrl`.
2. Install the custom node package into n8n if you need PTAB or application originals.
3. Create the credentials in n8n: USPTO ODP (Header Auth, `x-api-key`), GovInfo (Header Auth, `X-Api-Key`),
   CourtListener (Header Auth, `Authorization: Token …`), EPO OPS (OAuth2 client credentials against
   `https://ops.epo.org/3.2/auth/accesstoken`), Google BigQuery OAuth2, and one inbound Header Auth credential for
   the gateways. Select them on the HTTP Request nodes.
4. For CourtListener, set `internalUseAgreementConfirmed` in the core's Connection Settings only after reading the
   [Free Law Project allowed-use terms](https://free.law/membership/allowed-api-usage/).
5. Import and publish each `*-core` workflow, then its gateway.
6. Create a file containing `RESEARCH_GATEWAY_AUTH_HEADER_VALUE=Bearer <the inbound value>` outside the install
   folder, and configure the Hub:

   ```json
   {"transport": "n8n", "n8nBaseUrl": "http://127.0.0.1:5678", "gatewayAuthFile": "/absolute/path/to/gateway-auth.env"}
   ```

7. Run `node src/cli.mjs doctor` and one bounded query.

> Webhook IDs inside the shipped workflow JSON are regenerated when n8n imports a workflow, so the gateway URLs on your
> instance differ from the files. Access is controlled by the bearer file, not by the URL.

## n8n-only extras

- `model.json` and `src/model-proxy.mjs`: an OpenAI-compatible loopback model proxy for agent frameworks.
- `external-access*.json`, `patentsview-catalog*.json`, and the Office Action rejections workflows built by
  `scripts/build-oa-rejections-workflows.mjs`.
- `patentsview-landscape.json`: an example form that calls a separate batch-coordinator service over mTLS
  (`host.docker.internal:8780`). It does not work without such a service.
- File-form and XML-archive application downloads (`fileId` / `format`) use the live application-PDF core built by
  `scripts/build-live-application-pdf-core.mjs` from your own exported workflow.

These workflows were live-verified on the developers' own n8n 2.37 installation in 2026; the exported, sanitized
copies here have not been re-imported into a fresh n8n instance.
