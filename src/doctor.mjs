// Readiness report: which sources can run with the current configuration. It makes no network call and never prints
// a credential value; it reports only whether each variable or setting is present.
import fs from 'node:fs';
import {providers,providerReadiness} from './providers.mjs';
import {sources} from './sources.mjs';
import {configPath,dataDir,exportsDir,pythonExecutable,readConfig} from './config.mjs';

export function doctor({config,env=process.env}={}){
  config=config||readConfig({env});
  const provider=Object.keys(providers).map(id=>({...providerReadiness(id,{config,env}),sources:sources.filter(s=>s.provider===id).map(s=>s.id)}));
  const keyless=sources.filter(s=>['rss','links','directory'].includes(s.kind)).map(s=>s.id);
  const linkOnly=sources.filter(s=>s.kind==='external'&&!s.provider).map(s=>s.id);
  const getFiles=env.RESEARCH_GET_FILES_CLIENT||config.getFilesClientModule;
  const corpus=env.RESEARCH_CORPUS_CLIENT||config.corpusClientModule;
  const python=pythonExecutable(config,env);
  return {
    transport:config.transport,
    configFile:{path:configPath(env),exists:fs.existsSync(configPath(env))},
    dataDir:dataDir(config,env),exportsDir:exportsDir(config,env),
    keylessSources:{configured:true,sources:keyless,note:'Public official pages and feeds; no key needed.'},
    providers:provider,
    linkOnlySources:{sources:linkOnly,note:'Link generation only; no automated retrieval.'},
    bigQuery:{
      dryRunEnabled:config.googleBigQueryDryRunEnabled===true,
      executionEnabled:config.googleBigQueryExecutionEnabled===true,
      billingMode:config.googleBigQueryBillingMode,
      perQueryMaxBytes:String(config.googleBigQueryPerQueryMaxBytes),
      monthlyTrackedMaxBytes:String(config.googleBigQueryMonthlyTrackedMaxBytes),
      mode:config.googleBigQueryExecutionEnabled===true&&['sandbox-no-billing','billing-enabled-capped'].includes(config.googleBigQueryBillingMode)?'capped data queries enabled':'dry-run estimates only',
    },
    courtListener:{enabled:config.courtlistenerEnabled===true,termsAcknowledged:config.courtlistenerInternalUseAllowed===true,terms:providers.courtlistener.terms},
    integrations:{
      getFiles:{configured:Boolean(getFiles),used:'research_archive, research_jobs, research_passages, research_read_source, reference acquisition and indexing'},
      corpusClient:{configured:Boolean(corpus),used:'PatentsView intake (administrative)'},
      python:{found:Boolean(python),used:'charts in reports (needs matplotlib) and PatentsView preparation'},
      n8n:{selected:config.transport==='n8n',gatewayAuthFileSet:Boolean(config.gatewayAuthFile)},
    },
    verification:'Direct transport is covered by offline tests with mocked provider responses. It has NOT been verified against live providers in this release.',
  };
}
