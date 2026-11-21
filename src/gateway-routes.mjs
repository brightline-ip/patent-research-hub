// Routes the `gateway` command accepts. Source and document routes only: BigQuery routes (they can cost money) keep their
// own CLI commands and caps, and the n8n-only routes are not exposed.
export const GATEWAY_ROUTES=Object.freeze(['uspto','ptab','oa-rejections','ptab-files','application-documents','application-pdf','govinfo','courtlistener','epo','public','reference-index']);
