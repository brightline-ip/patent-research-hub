import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export function buildPatentDocumentWorkflows(){
  return ['application-documents-core','application-documents','application-pdf-core','application-pdf']
    .map(name=>JSON.parse(fs.readFileSync(new URL('../workflows/'+name+'.json',import.meta.url),'utf8')))
    .map(workflow=>({...workflow,active:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const workflows=buildPatentDocumentWorkflows();
  fs.writeFileSync(new URL('../deployment/patent-document-workflows.json',import.meta.url),JSON.stringify(workflows,null,2));
  console.log('Prepared four inactive application-document workflows. The bounded original node is a local candidate requiring isolated runtime testing before deployment.');
}
