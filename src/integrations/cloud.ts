import { createReadStream } from "node:fs";
import { open,stat,type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
export type CloudProvider="dropbox"|"google"|"onedrive"|"box";
interface CloudOptions {token:string;folder?:string;name?:string;endpoint?:string;signal?:AbortSignal;chunkBytes?:number;retryDelayMs?:number}
type Step={done:true;value:unknown}|{done:false;next:number};
const MAX_RETRIES=5,MAX_RETRY_WAIT_MS=60000,REQUEST_TIMEOUT_MS=120000;
/** A failure worth repeating: dropped connections, timeouts, rate limits and provider errors. */
class TransientUploadError extends Error{constructor(message:string,readonly retryAfterMs?:number){super(message);}}
async function once(url:string,options:RequestInit & {duplex?:"half"},signal?:AbortSignal,accept:number[]=[]):Promise<Response>{
 let response:Response;
 try{response=await fetch(url,{...options,redirect:"manual",signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(REQUEST_TIMEOUT_MS)])});}
 catch{signal?.throwIfAborted();throw new TransientUploadError("Cloud upload connection failed.");}
 if(response.ok||accept.includes(response.status))return response;
 await response.body?.cancel();const message=`Cloud upload failed (${response.status}).`;
 if(response.status===408||response.status===429||response.status>=500){const after=Number(response.headers.get("retry-after"));throw new TransientUploadError(message,Number.isFinite(after)&&after>=0&&response.headers.has("retry-after")?after*1000:undefined);}
 throw new Error(message);
}
function pause(error:TransientUploadError,attempt:number,options:CloudOptions):Promise<unknown>{return delay(Math.min(MAX_RETRY_WAIT_MS,error.retryAfterMs??(options.retryDelayMs??1000)*2**attempt),undefined,{signal:options.signal});}
/** Repeats a request that is safe to send twice, such as opening an upload session. */
async function checked(url:string,request:RequestInit,options:CloudOptions):Promise<Response>{
 for(let attempt=0;;attempt++){
  try{return await once(url,request,options.signal);}
  catch(error){if(!(error instanceof TransientUploadError)||attempt>=MAX_RETRIES)throw error;await pause(error,attempt,options);}
 }
}
/** Sends a file in pieces. After a failure, recover asks where the provider actually got to before continuing. */
async function uploadChunks(file:FileHandle,size:number,fallbackChunkBytes:number,options:CloudOptions,chunk:(bytes:Buffer<ArrayBuffer>,offset:number)=>Promise<Step>,recover:(offset:number)=>Promise<Step>):Promise<unknown>{
 if(!size)throw new Error("Empty cloud uploads are not supported.");
 const chunkBytes=options.chunkBytes??fallbackChunkBytes;let offset=0,failures=0;
 for(;;){
  options.signal?.throwIfAborted();
  const bytes=Buffer.alloc(Math.min(chunkBytes,size-offset)),read=await file.read(bytes,0,bytes.length,offset);if(!read.bytesRead)throw new Error("Cloud source changed during upload.");
  let step:Step|undefined;
  try{step=await chunk(bytes.subarray(0,read.bytesRead),offset);}
  catch(error){
   if(!(error instanceof TransientUploadError)||failures>=MAX_RETRIES)throw error;
   await pause(error,failures++,options);
   try{step=await recover(offset);}catch(recoverError){if(!(recoverError instanceof TransientUploadError))throw recoverError;}
   if(!step)continue;
   if(step.done)return step.value;
   offset=step.next;continue;
  }
  if(step.done)return step.value;
  if(step.next>offset)failures=0;
  else if(failures>=MAX_RETRIES)throw new Error("Cloud upload stopped making progress.");
  else failures++;
  offset=step.next;
 }
}
/** Finds or creates a Drive folder. The drive.file scope only sees folders this app created. */
export async function googleFolderID(name:string,options:Pick<CloudOptions,"token"|"endpoint"|"signal"|"retryDelayMs">):Promise<string>{
 const endpoint=options.endpoint??"https://www.googleapis.com/drive/v3/files",authorization=`Bearer ${options.token}`;
 const query=`name='${name.replace(/[\\']/g,"\\$&")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
 const found=await (await checked(`${endpoint}?${new URLSearchParams({q:query,fields:"files(id)",pageSize:"1"})}`,{headers:{Authorization:authorization}},options)).json() as {files?:{id:string}[]};
 if(found.files?.[0]?.id)return found.files[0].id;
 const created=await (await checked(`${endpoint}?fields=id`,{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({name,mimeType:"application/vnd.google-apps.folder"})},options)).json() as {id?:string};
 if(!created.id)throw new Error("Missing Google folder.");return created.id;
}
/** Owner-configured OAuth tokens; never expose tokens to browsers or manifests. */
export async function uploadFile(provider:CloudProvider,filename:string,options:CloudOptions):Promise<unknown>{
 options.signal?.throwIfAborted();
 if(!options.token)throw new Error("Cloud account is not configured.");
 const size=(await stat(filename)).size,name=options.name??path.basename(filename),authorization=`Bearer ${options.token}`;
 const file=await open(filename,"r");
 try{
  if(provider==="dropbox"){
   const endpoint=options.endpoint??"https://content.dropboxapi.com/2/files";
   const start=await checked(endpoint+"/upload_session/start",{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify({close:false})},body:Buffer.alloc(0)},options);
   const session=(await start.json() as {session_id:string}).session_id;
   // Dropbox has no status request: a repeated chunk is refused with the offset it expects next.
   return await uploadChunks(file,size,8*1024*1024,options,async(bytes,offset)=>{
    const last=offset+bytes.length===size;
    const arg=last?{cursor:{session_id:session,offset},commit:{path:`/${[options.folder,name].filter(Boolean).join("/")}`,mode:"add",autorename:true}}:{cursor:{session_id:session,offset},close:false};
    const response=await once(endpoint+(last?"/upload_session/finish":"/upload_session/append_v2"),{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify(arg)},body:bytes},options.signal,[409]);
    if(response.status===409){
     const failure=await response.json().catch(()=>undefined) as {error?:{correct_offset?:unknown;lookup_failed?:{correct_offset?:unknown}}}|undefined,correct=failure?.error?.correct_offset??failure?.error?.lookup_failed?.correct_offset;
     if(typeof correct!=="number")throw new Error("Cloud upload failed (409).");
     return {done:false,next:correct};
    }
    if(last)return {done:true,value:await response.json()};
    await response.arrayBuffer();return {done:false,next:offset+bytes.length};
   },async offset=>({done:false,next:offset}));
  }
  if(provider==="google"){
   const endpoint=options.endpoint??"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
   const start=await checked(endpoint,{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json","X-Upload-Content-Type":"application/octet-stream","X-Upload-Content-Length":String(size)},body:JSON.stringify({name,...(options.folder?{parents:[options.folder]}:{})})},options);
   const location=start.headers.get("location");if(!location)throw new Error("Missing Google upload session.");
   // The session address authorizes these requests, so a long upload outlives the access token. A 308 reports how much Google has kept, which can be less than was sent.
   const step=async(response:Response):Promise<Step>=>{if(response.status!==308)return {done:true,value:await response.json()};await response.arrayBuffer();const kept=/^bytes=0-(\d+)$/.exec(response.headers.get("range")??"");return {done:false,next:kept?Number(kept[1])+1:0};};
   return await uploadChunks(file,size,8*1024*1024,options,async(bytes,offset)=>step(await once(location,{method:"PUT",headers:{"Content-Type":"application/octet-stream","Content-Range":`bytes ${offset}-${offset+bytes.length-1}/${size}`},body:bytes},options.signal,[308])),
    async()=>step(await once(location,{method:"PUT",headers:{"Content-Range":`bytes */${size}`}},options.signal,[308])));
  }
  if(provider==="onedrive"){
   const endpoint=options.endpoint??"https://graph.microsoft.com/v1.0/me/drive";
   const locationPath=[options.folder,name].filter(Boolean).map(value=>value!.split("/").map(encodeURIComponent).join("/")).join("/");
   const start=await checked(`${endpoint}/special/approot:/${locationPath}:/createUploadSession`,{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({item:{"@microsoft.graph.conflictBehavior":"rename",name}})},options);
   const location=(await start.json() as {uploadUrl:string}).uploadUrl;
   const recover=async():Promise<Step>=>{const status=await (await once(location,{method:"GET"},options.signal)).json() as {nextExpectedRanges?:string[]},next=parseInt(status.nextExpectedRanges?.[0]??"",10);if(!Number.isInteger(next))throw new Error("Cloud upload session could not be resumed.");return {done:false,next};};
   // Chunks must be multiples of 320 KiB. A 416 means this range was already received.
   return await uploadChunks(file,size,10*320*1024,options,async(bytes,offset)=>{
    const response=await once(location,{method:"PUT",headers:{"Content-Range":`bytes ${offset}-${offset+bytes.length-1}/${size}`},body:bytes},options.signal,[416]);
    if(response.status===416){await response.arrayBuffer();return recover();}
    if(response.status===202){await response.arrayBuffer();return {done:false,next:offset+bytes.length};}
    return {done:true,value:await response.json()};
   },recover);
  }
  if(provider==="box"){
   const endpoint=options.endpoint??"https://upload.box.com/api/2.0/files/content",boundary="witness-"+randomUUID();
   const attributes=JSON.stringify({name,parent:{id:options.folder??"0"}});
   const prefix=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\n\r\n${attributes}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replace(/["\r\n]/g,"_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`),suffix=Buffer.from(`\r\n--${boundary}--\r\n`);
   async function* body(){yield prefix;yield* createReadStream(filename);yield suffix;}
   // A streamed body cannot be sent twice, so Box gets one attempt.
   return (await once(endpoint,{method:"POST",headers:{Authorization:authorization,"Content-Type":`multipart/form-data; boundary=${boundary}`,"Content-Length":String(prefix.length+size+suffix.length)},body:Readable.toWeb(Readable.from(body())) as ReadableStream,duplex:"half"},options.signal)).json();
  }
  throw new Error("Unsupported cloud provider.");
 }finally{await file.close();}
}
