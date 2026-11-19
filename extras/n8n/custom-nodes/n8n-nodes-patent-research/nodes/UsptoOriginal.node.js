'use strict';
const {downloadOriginal,downloadPtabOriginal}=require('./bounded-download.js');
class UsptoOriginal{
  constructor(){this.description={displayName:'USPTO Bounded Original',name:'usptoOriginal',group:['transform'],version:1,description:'Identity-bound public original with streaming limits; USPTO credential stays in n8n',defaults:{name:'USPTO Bounded Original'},inputs:['main'],outputs:['main'],credentials:[{name:'httpHeaderAuth',required:true}],properties:[
    {displayName:'Operation',name:'operation',type:'options',default:'application',options:[{name:'Application File Wrapper',value:'application'},{name:'PTAB Decision',value:'ptab'}]},
    {displayName:'Application Number',name:'applicationNumber',type:'string',default:'',displayOptions:{show:{operation:['application']}},required:true},
    {displayName:'Trial Number',name:'trialNumber',type:'string',default:'',displayOptions:{show:{operation:['ptab']}}},
    {displayName:'Appeal Number',name:'appealNumber',type:'string',default:'',displayOptions:{show:{operation:['ptab']}}},
    {displayName:'Document Identifier',name:'documentIdentifier',type:'string',default:'',required:true},
    {displayName:'Native DOCX Filename (Optional)',name:'nativeFilename',type:'string',default:'',displayOptions:{show:{operation:['application']}}},
    {displayName:'Maximum Bytes (PTAB 10485760; application up to 41943040)',name:'maxBytes',type:'number',default:10485760,typeOptions:{minValue:5,maxValue:41943040}},
    {displayName:'Deadline (Milliseconds; PTAB 60000, application up to 180000)',name:'timeoutMs',type:'number',default:60000,typeOptions:{minValue:1000,maxValue:180000}}
  ]};}
  async execute(){
    if(this.getInputData().length!==1)throw Error('Download one original per invocation');
    const credential=await this.getCredentials('httpHeaderAuth');
    if(String(credential.name).toLowerCase()!=='x-api-key')throw Error('Select the existing USPTO x-api-key credential');
    const operation=this.getNodeParameter('operation',0,'application');
    const options={apiKey:credential.value,maxBytes:this.getNodeParameter('maxBytes',0),timeoutMs:this.getNodeParameter('timeoutMs',0)};
    const result=operation==='ptab'?await downloadPtabOriginal({trial_number:this.getNodeParameter('trialNumber',0,''),appeal_number:this.getNodeParameter('appealNumber',0,''),document_identifier:this.getNodeParameter('documentIdentifier',0)},options):await downloadOriginal({application_number:this.getNodeParameter('applicationNumber',0),document_identifier:this.getNodeParameter('documentIdentifier',0),native_filename:this.getNodeParameter('nativeFilename',0,'')},options);
    return [[{json:result,pairedItem:{item:0}}]];
  }
}
module.exports={UsptoOriginal};
