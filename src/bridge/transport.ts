import {MAX_LINE,controlSchema}from'./protocol.js';
import type{Writable}from'node:stream';
export class Transport{
 sequence=0;private pending?:{sequence:number,resolve:(v:any)=>void,reject:(e:Error)=>void};
 constructor(private output:Writable,readonly runId:string,readonly controller:AbortController){}
 control(raw:unknown){const c=controlSchema.parse(raw);if(c.run_id!==this.runId)throw Error('WRONG_RUN');if(c.type==='cancel'){this.controller.abort();return;}if(!this.pending||c.message_seq!==this.pending.sequence)throw Error('UNEXPECTED_ACK');const pending=this.pending;this.pending=undefined;if(!c.continue)pending.reject(Error('PERSISTENCE_REJECTED'));else pending.resolve(c);}
 async send(type:string,body:Record<string,unknown>={},requiresAck=false){
 const seq=requiresAck?++this.sequence:undefined;const message={protocol_version:1,type,run_id:this.runId,...(seq?{message_seq:seq}:{}),...body};const line=JSON.stringify(message)+'\n';if(Buffer.byteLength(line)>MAX_LINE)throw Error('METADATA_TOO_LARGE');
 let timer:NodeJS.Timeout|undefined;const ack=requiresAck?new Promise((resolve,reject)=>{this.pending={sequence:seq!,resolve,reject};timer=setTimeout(()=>{this.pending=undefined;reject(Error('ACK_TIMEOUT'));},30000);}):Promise.resolve();
 this.output.write(line);try{return await ack;}finally{if(timer)clearTimeout(timer);}
 }
 close(){this.controller.abort();this.pending?.reject(Error('PIPE_CLOSED'));this.pending=undefined;}
}
