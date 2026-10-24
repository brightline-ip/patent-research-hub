// Read-only audit: report only counts of credential-shaped values, never values.
import {DatabaseSync} from 'node:sqlite';
import {redactSensitiveText} from '../src/security.mjs';
const file=process.argv.slice(2).find(x=>!x.startsWith('--'))||'data/research.sqlite';
const db=new DatabaseSync(file,{readOnly:true});
try{
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const matches=[];
  for(const {name:table} of tables){
    if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected table name');
    const columns=db.prepare(`PRAGMA table_info(${table})`).all().filter(x=>String(x.type).toUpperCase().includes('TEXT'));
    for(const {name:column} of columns){
      if(!/^[a-z_]+$/.test(column))throw new Error('Unexpected column name');
      let count=0;const samples=[];for(const row of db.prepare(`SELECT ${column} AS value FROM ${table}`).iterate()){const value=String(row.value??''),redacted=redactSensitiveText(value);if(redacted!==value){count++;if(process.argv.includes('--redacted-samples')&&samples.length<3){const at=redacted.indexOf('[REDACTED');samples.push(redacted.slice(Math.max(0,at-80),at+120).replace(/[\r\n\t]+/g,' '));}}}
      if(count)matches.push({table,column,count,...(samples.length?{redactedSamples:samples}:{})});
    }
  }
  console.log(JSON.stringify({database:file,tablesScanned:tables.length,sensitivePatternMatches:matches},null,2));
}finally{db.close();}
