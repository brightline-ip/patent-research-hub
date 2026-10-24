import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('A different MCP client resumes a research handoff saved by another client',{skip:process.env.PATENT_SKIP_SUBPROCESS_TESTS==='1'},async()=>{
  const session='migration-test-'+randomUUID();
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'patent-migration-'));
  const cleanupPath=home;
  const entry=path.resolve('src/mcp.mjs');
  const env={...process.env,PATENT_RESEARCH_CONFIG:path.join(home,'absent-config.json'),PATENT_RESEARCH_DATA_DIR:path.join(home,'data'),PATENT_RESEARCH_EXPORTS_DIR:path.join(home,'exports')};
  async function connect(name){
    const client=new Client({name,version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[entry],env,stderr:'pipe'}));
    return client;
  }
  let first,second;
  try{
    first=await connect('original-interface');
    const saved=await first.callTool({name:'research_checkpoint',arguments:{session,objective:'Synthetic migration acceptance check',scope:'Public test fixture only',findings:['No factual legal conclusion asserted.'],nextSteps:['Resume through a different MCP client.']}});
    assert.ok(!saved.isError);
    const checkpoint=JSON.parse(saved.content[0].text);
    await first.close();first=null;
    second=await connect('replacement-interface');
    const result=await second.callTool({name:'research_resume',arguments:{session}});
    assert.ok(!result.isError);
    const resumed=JSON.parse(result.content[0].text);
    assert.equal(resumed.checkpoint.version,checkpoint.version);
    assert.equal(resumed.checkpoint.objective,'Synthetic migration acceptance check');
    assert.ok(fs.existsSync(path.join(home,'data','checkpoints',session)));
  }finally{
    await first?.close();await second?.close();
    fs.rmSync(cleanupPath,{recursive:true,force:true});
  }
});
