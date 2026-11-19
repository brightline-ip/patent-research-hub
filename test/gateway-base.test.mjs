import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayBase} from '../src/gateway.mjs';

// 2026-11-09: clients may call a remote research gateway over https, only on the host named in n8nRemoteHost.
const ok=(url,extra={})=>gatewayBase({n8nBaseUrl:url,...extra}).origin;
const bad=(url,extra={})=>assert.throws(()=>gatewayBase({n8nBaseUrl:url,...extra}));
test('loopback http stays allowed', ()=>{
  assert.equal(ok('http://127.0.0.1:5678'),'http://127.0.0.1:5678');
  assert.equal(ok('http://localhost:5678/'),'http://localhost:5678');
});
test('https is allowed only on the opted-in host', ()=>{
  assert.equal(ok('https://research.example.org',{n8nRemoteHost:'research.example.org'}),'https://research.example.org');
  bad('https://research.example.org');                                            // no opt-in
  bad('https://other.example.org',{n8nRemoteHost:'research.example.org'});        // different host
  bad('https://research.example.org.evil.test',{n8nRemoteHost:'research.example.org'});
  bad('http://research.example.org',{n8nRemoteHost:'research.example.org'});      // remote must be https
});
test('no credentials, path, query or fragment in the base', ()=>{
  const h={n8nRemoteHost:'research.example.org'};
  bad('https://u:p@research.example.org',h); bad('https://research.example.org/n8n',h);
  bad('https://research.example.org/?a=1',h); bad('https://research.example.org/#x',h);
  bad('http://user@127.0.0.1:5678');
});
