import fs from 'node:fs';
import path from 'node:path';

const [credentialId, credentialName] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{8,80}$/.test(credentialId ?? '')) throw new Error('Supply the n8n BigQuery credential ID');
if (typeof credentialName !== 'string' || credentialName.length < 3 || credentialName.length > 100) throw new Error('Supply the n8n BigQuery credential name');

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const inputs = ['examiner-bigquery-core.json', 'examiner-bigquery.json', 'examiner-bigquery-query-core.json', 'examiner-bigquery-query.json'];
const workflows = inputs.map(file => JSON.parse(fs.readFileSync(path.join(root, 'extras', 'n8n', 'workflows', file), 'utf8')));
for (const workflow of workflows) {
  for (const node of workflow.nodes) {
    if (node.type.endsWith('.httpRequest') && node.parameters.nodeCredentialType === 'googleBigQueryOAuth2Api') {
      node.credentials = {googleBigQueryOAuth2Api: {id: credentialId, name: credentialName}};
    }
  }
}
const bound = workflows.flatMap(workflow => workflow.nodes.filter(node => node.credentials?.googleBigQueryOAuth2Api)).length;
if (bound !== 4) throw new Error(`Expected four BigQuery credential bindings; found ${bound}`);
fs.mkdirSync(path.join(root, 'data'), {recursive: true});
const output = path.join(root, 'data', 'examiner-deployment.json');
fs.writeFileSync(output, JSON.stringify(workflows, null, 2));
console.log(`Prepared ${workflows.length} examiner workflows with ${bound} n8n credential references at ${output}.`);
