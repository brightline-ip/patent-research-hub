import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {externalAccess} from '../src/external-access.mjs';
import {sources} from '../src/sources.mjs';

test('WIPO helpers are explicit manual access contracts, not retrieval',()=>{
 const q='G06N neural network & applicant:example';
 const patentscope=externalAccess({source:'wipo-patentscope',query:q});
 assert.equal(patentscope.mode,'manual-search-access');
 assert.equal(patentscope.searchFor,q);
 assert.equal(patentscope.retrieved,false);
 assert.equal(patentscope.connected,false);
 assert.equal(patentscope.automaticPolling,false);
 assert.match(patentscope.reason,/prohibits robots/i);
 const statistics=externalAccess({source:'wipo-ip-statistics',query:'applications by origin'});
 assert.equal(statistics.mode,'manual-data-access');
 assert.equal(statistics.retrieved,false);
 assert.equal(statistics.connected,false);
 assert.equal(statistics.automaticPolling,false);
 assert.match(statistics.reason,/does not submit/i);
 assert.equal(new URL(statistics.url).hostname,'www3.wipo.int');
 for(const id of ['wipo-patentscope','wipo-ip-statistics'])assert.equal(sources.find(source=>source.id===id)?.kind,'external');
});

test('portable n8n access core exposes the same credential-free WIPO contract',()=>{
 const workflow=JSON.parse(fs.readFileSync(new URL('../extras/n8n/workflows/external-access-core.json',import.meta.url),'utf8'));
 assert.equal(workflow.active,false);
 assert.equal(workflow.nodes.some(node=>node.credentials),false);
 const code=workflow.nodes.find(node=>node.name==='Build Provider Access').parameters.jsCode;
 assert.match(code,/wipo-ip-statistics/);
 const fn=code.slice(0,code.indexOf(';const j='));
 const result=vm.runInNewContext(`(${fn})({source:'wipo-ip-statistics',query:'applications'})`);
 assert.equal(result.retrieved,false);
 assert.equal(result.mode,'manual-data-access');
});
