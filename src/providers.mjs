// Keyed providers used by the direct transport: which environment variables or settings each needs, where a user
// registers for their own credential, and the provider terms to read first. Values are never read or printed here;
// readiness only reports whether a variable is set. Links were current when this release was prepared; verify them.
import fs from 'node:fs';

export const providers=Object.freeze({
  uspto:{
    name:'USPTO Open Data Portal (patent file wrapper, PTAB trials and appeals, originals)',
    env:['USPTO_API_KEY'],
    register:'https://data.uspto.gov/apis/getting-started',
    terms:'https://data.uspto.gov/',
    limits:'USPTO allows one call at a time per key, about 4 to 15 requests per second, and asks for at least 5 s after an HTTP 429; the Hub takes turns across processes, spaces requests at least 1 s apart by default and holds the key back after a 429. An ID.me-verified account is needed, and a key unused for 90 days is deleted.',
  },
  epo:{
    name:'EPO Open Patent Services (OPS)',
    env:['EPO_OPS_CONSUMER_KEY','EPO_OPS_CONSUMER_SECRET'],
    alternativeEnv:['EPO_ACCESS_TOKEN'],
    register:'https://developers.epo.org/user/register',
    terms:'https://www.epo.org/en/service-support/ordering/terms-and-conditions/ops-terms-and-conditions',
    limits:'OPS fair-use weekly quota and throttling per registered application. OAuth tokens are cached until shortly before expiry.',
  },
  govinfo:{
    name:'GovInfo API (USCOURTS opinions)',
    env:['GOVINFO_API_KEY'],
    register:'https://www.govinfo.gov/api-signup',
    terms:'https://github.com/usgpo/api',
    limits:'api.data.gov keys default to about 1,000 requests per hour; the Hub spaces requests 3.6 s apart by default.',
  },
  courtlistener:{
    name:'CourtListener (Free Law Project)',
    env:['COURTLISTENER_TOKEN'],
    settings:['courtlistenerEnabled','courtlistenerInternalUseAllowed'],
    register:'https://wiki.free.law/c/courtlistener/help/api/rest/v4/rest-api-v47',
    terms:'https://free.law/membership/allowed-api-usage/',
    limits:'Disabled by default. Enable only after reading Free Law Project allowed-use terms; set both settings to true.',
  },
  bigquery:{
    name:'Google BigQuery (Google Patents Public Datasets and hosted PatEx)',
    env:['GOOGLE_APPLICATION_CREDENTIALS','BIGQUERY_PROJECT_ID'],
    register:'https://cloud.google.com/bigquery/docs/sandbox',
    terms:'https://cloud.google.com/bigquery/pricing',
    limits:'Dry-run byte estimates by default. Data queries run only when enabled in config and under the per-query and monthly byte caps. Queries can incur charges on a billing-enabled project.',
  },
});

export class NotConfiguredError extends Error{
  constructor(provider,missing,extra=''){
    const p=providers[provider];
    super(`${p.name} is not configured (missing: ${missing.join(', ')}). Register: ${p.register}${extra?'. '+extra:''}`);
    this.code='NOT_CONFIGURED';
    this.notConfigured={status:'not_configured',provider,name:p.name,missing,register:p.register,terms:p.terms,note:extra||p.limits};
  }
}

// Readiness without reading secret values. config is the merged configuration (src/config.mjs).
export function providerReadiness(id,{config={},env=process.env}={}){
  const p=providers[id];if(!p)throw new Error('Unknown provider');
  let missing=p.env.filter(name=>!env[name]);
  if(id==='epo'&&missing.length&&env.EPO_ACCESS_TOKEN)missing=[];
  if(id==='bigquery'){
    missing=[];
    if(!env.GOOGLE_APPLICATION_CREDENTIALS)missing.push('GOOGLE_APPLICATION_CREDENTIALS');
    else if(!fs.existsSync(env.GOOGLE_APPLICATION_CREDENTIALS))missing.push('GOOGLE_APPLICATION_CREDENTIALS (file not found)');
    if(!config.googleBigQueryProjectId&&!env.BIGQUERY_PROJECT_ID)missing.push('BIGQUERY_PROJECT_ID');
  }
  if(id==='courtlistener'){
    if(config.courtlistenerEnabled!==true)missing.push('config courtlistenerEnabled=true');
    if(config.courtlistenerInternalUseAllowed!==true)missing.push('config courtlistenerInternalUseAllowed=true (after reading '+p.terms+')');
  }
  return {provider:id,name:p.name,configured:missing.length===0,missing,register:p.register,terms:p.terms,limits:p.limits};
}

export function requireProvider(id,context){const r=providerReadiness(id,context);if(!r.configured)throw new NotConfiguredError(id,r.missing);return r;}
