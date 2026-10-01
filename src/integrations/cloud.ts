import { createReadStream } from "node:fs";
import { open,stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
export type CloudProvider="dropbox"|"google"|"onedrive"|"box";
interface CloudOptions {token:string;folder?:string;name?:string;endpoint?:string;signal?:AbortSignal}
async function checked(url:string,options:RequestInit & {duplex?:"half"},signal?:AbortSignal):Promise<Response>{
 const response=await fetch(url,{...options,signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)])});
 if(!response.ok)throw new Error(`Cloud upload failed (${response.status}).`);
 return response;
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
   const start=await checked(endpoint+"/upload_session/start",{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify({close:false})},body:Buffer.alloc(0)},options.signal);
   const session=(await start.json() as {session_id:string}).session_id;let offset=0;const chunkSize=8*1024*1024;
   while(offset<size){const bytes=Buffer.alloc(Math.min(chunkSize,size-offset));const read=await file.read(bytes,0,bytes.length,offset);if(!read.bytesRead)throw new Error("Cloud source changed during upload.");
    const last=offset+read.bytesRead===size;
    const arg=last?{cursor:{session_id:session,offset},commit:{path:`/${[options.folder,name].filter(Boolean).join("/")}`,mode:"add",autorename:true}}:{cursor:{session_id:session,offset},close:false};
    const response=await checked(endpoint+(last?"/upload_session/finish":"/upload_session/append_v2"),{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify(arg)},body:bytes.subarray(0,read.bytesRead)},options.signal);
    offset+=read.bytesRead;if(last)return response.json();await response.arrayBuffer();
   }
   throw new Error("Empty cloud uploads are not supported.");
  }
  if(provider==="google"){
   const endpoint=options.endpoint??"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
   const start=await checked(endpoint,{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json","X-Upload-Content-Type":"application/octet-stream","X-Upload-Content-Length":String(size)},body:JSON.stringify({name,...(options.folder?{parents:[options.folder]}:{})})},options.signal);
   const location=start.headers.get("location");if(!location)throw new Error("Missing Google upload session.");
   return (await checked(location,{method:"PUT",headers:{Authorization:authorization,"Content-Type":"application/octet-stream","Content-Length":String(size)},body:Readable.toWeb(createReadStream(filename)) as ReadableStream,duplex:"half"},options.signal)).json();
  }
  if(provider==="onedrive"){
   const endpoint=options.endpoint??"https://graph.microsoft.com/v1.0/me/drive";
   const locationPath=[options.folder,name].filter(Boolean).map(value=>value!.split("/").map(encodeURIComponent).join("/")).join("/");
   const start=await checked(`${endpoint}/root:/${locationPath}:/createUploadSession`,{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify({item:{"@microsoft.graph.conflictBehavior":"rename",name}})},options.signal);
   const location=(await start.json() as {uploadUrl:string}).uploadUrl;
   let offset=0;const chunkSize=10*320*1024;
   while(offset<size){const bytes=Buffer.alloc(Math.min(chunkSize,size-offset));const read=await file.read(bytes,0,bytes.length,offset);if(!read.bytesRead)throw new Error("Cloud source changed during upload.");
    const response=await checked(location,{method:"PUT",headers:{"Content-Length":String(read.bytesRead),"Content-Range":`bytes ${offset}-${offset+read.bytesRead-1}/${size}`},body:bytes.subarray(0,read.bytesRead)},options.signal);offset+=read.bytesRead;if(offset===size)return response.json();await response.arrayBuffer();
   }throw new Error("Empty cloud uploads are not supported.");
  }
  if(provider==="box"){
   const endpoint=options.endpoint??"https://upload.box.com/api/2.0/files/content",boundary="witness-"+randomUUID();
   const attributes=JSON.stringify({name,parent:{id:options.folder??"0"}});
   const prefix=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\n\r\n${attributes}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replace(/["\r\n]/g,"_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`),suffix=Buffer.from(`\r\n--${boundary}--\r\n`);
   async function* body(){yield prefix;yield* createReadStream(filename);yield suffix;}
   return (await checked(endpoint,{method:"POST",headers:{Authorization:authorization,"Content-Type":`multipart/form-data; boundary=${boundary}`,"Content-Length":String(prefix.length+size+suffix.length)},body:Readable.toWeb(Readable.from(body())) as ReadableStream,duplex:"half"},options.signal)).json();
  }
  throw new Error("Unsupported cloud provider.");
 }finally{await file.close();}
}
