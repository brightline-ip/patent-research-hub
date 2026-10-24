import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','..','..');
const files=fs.readdirSync(path.join(root,'extras','n8n','workflows')).filter(x=>x.endsWith('.json'));
const workflows=files.map(x=>JSON.parse(fs.readFileSync(path.join(root,'extras','n8n','workflows',x),'utf8')));
if(new Set(workflows.map(x=>x.id)).size!==workflows.length)throw new Error('Duplicate workflow ID');
fs.mkdirSync(path.join(root,'extras','n8n','deployment'),{recursive:true});
fs.writeFileSync(path.join(root,'extras','n8n','deployment','workflows.json'),JSON.stringify(workflows,null,2));
console.log('Prepared '+workflows.length+' inactive workflows with credential references only.');
