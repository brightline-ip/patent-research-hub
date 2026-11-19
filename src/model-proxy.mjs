import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readConfig,gatewayAuth,callGateway} from './gateway.mjs';
export function createProxy({config=readConfig(),call=callGateway,auth=gatewayAuth(config)}={}){
  let active=0;
  // The shipped settings define no models; treat that as an empty list rather than crashing on config.models.
  const models=Array.isArray(config.models)?config.models:[];
  return http.createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.url==='/health'&&req.method==='GET')return send(200,{service:'patent-research-model-proxy',status:'ready',upstream:'not-checked'});
    const got=Buffer.from(req.headers.authorization||''),want=Buffer.from(auth);
    if(got.length!==want.length||!timingSafeEqual(got,want))return send(401,{error:{message:'Authentication required'}});
    if(req.method==='GET'&&req.url==='/v1/models')return send(200,{object:'list',data:models.map(id=>({id,object:'model',owned_by:'configured-n8n-provider'}))});
    if(req.method!=='POST'||req.url!=='/v1/chat/completions')return send(404,{error:{message:'Unknown endpoint'}});
    if(active>=2)return send(429,{error:{message:'Research model connection is busy'}});
    active++;
    try{
      const blocks=[];let size=0;for await(const b of req){size+=b.length;if(size>1800000){send(413,{error:{message:'Context request exceeds configured limit'}});return;}blocks.push(b);}
      let body;try{body=JSON.parse(Buffer.concat(blocks).toString());}catch{return send(400,{error:{message:'Invalid JSON'}});}
      if(!Array.isArray(body.messages)||!models.includes(body.model||config.defaultModel))return send(400,{error:{message:'Invalid messages or unconfigured model'}});
      const result=await call('model',{...body,model:body.model||config.defaultModel,stream:false},{config});
      if(!Array.isArray(result.choices))throw new Error('Provider returned no chat completion');
      if(!body.stream)return send(200,result);
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
      const common={id:result.id,object:'chat.completion.chunk',created:result.created,model:result.model};
      for(const c of result.choices){const delta={...c.message};if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((t,index)=>({...t,index}));res.write('data: '+JSON.stringify({...common,choices:[{index:c.index,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...common,choices:[{index:c.index,delta:{},finish_reason:c.finish_reason}]})+'\n\n');}
      if(result.usage)res.write('data: '+JSON.stringify({...common,choices:[],usage:result.usage})+'\n\n');
      res.end('data: [DONE]\n\n');
    }catch{if(!res.headersSent)send(502,{error:{message:'n8n model workflow unavailable or failed. Check publication, selected credential, and model access.'}});else res.end();}
    finally{active--;}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const config=readConfig();createProxy({config}).listen(config.modelProxyPort,'127.0.0.1',()=>console.log('Research model proxy listening on loopback port '+config.modelProxyPort));}
