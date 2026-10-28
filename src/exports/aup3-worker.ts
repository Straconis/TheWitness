import {deprioritize} from "./process";
import {DatabaseSync} from "node:sqlite";
import {parentPort,workerData} from "node:worker_threads";
import {spawn,ChildProcessWithoutNullStreams} from "node:child_process";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {openSync,closeSync,statfsSync,statSync,existsSync,rmSync} from "node:fs";

export interface NativeTrackInput {file:string;username:string;frames:number;format:"int16"|"float"}
export interface NativeProjectInput {output:string;tracks:NativeTrackInput[];notes:Array<{seconds:number;text:string}>;ffmpeg:string;reserveBytes:number}
interface Block {start:number;length:number;id:number}
interface Track {name:string;frames:number;format:number;maxSamples:number;channels:[Block[],Block[]]}
interface Element {name:string;attrs?:Record<string,string|number>;children?:Element[]}
const FLOAT=0x0004000f,INT16=0x00020001;
const clean=(s:string)=>s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,"");
function element(name:string,attrs:Element["attrs"]={},children:Element[]=[]):Element{return {name,attrs,children};}

/** Original encoder of Audacity's dictionary-backed XML container; all attributes use UTF-8 strings. */
export function encodeProject(root:Element):{dict:Buffer;doc:Buffer}{
 const names=new Map<string,number>(),dictionary:Buffer[]=[Buffer.from([0,1])],document:Buffer[]=[];
 const id=(name:string)=>{let value=names.get(name);if(value===undefined){value=names.size;if(value>65535)throw Error("Too many native project field names.");names.set(name,value);const bytes=Buffer.from(name,"utf8"),header=Buffer.alloc(5);header[0]=15;header.writeUInt16LE(value,1);header.writeUInt16LE(bytes.length,3);dictionary.push(header,bytes);}return value;};
 const tag=(type:number,name:string)=>{const b=Buffer.alloc(3);b[0]=type;b.writeUInt16LE(id(name),1);document.push(b);};
 const visit=(node:Element)=>{tag(1,node.name);for(const [name,value] of Object.entries(node.attrs??{})){const text=Buffer.from(clean(String(value)),"utf8"),header=Buffer.alloc(7);header[0]=3;header.writeUInt16LE(id(name),1);header.writeInt32LE(text.length,3);document.push(header,text);}for(const child of node.children??[])visit(child);tag(2,node.name);};
 visit(root);return {dict:Buffer.concat(dictionary),doc:Buffer.concat(document)};
}
function documentFor(tracks:Track[],notes:NativeProjectInput["notes"]):Element{
 const children:Element[]=[element("tags")];
 for(const track of tracks)for(let channel=0;channel<2;channel++){
  const sequence=element("sequence",{maxsamples:track.maxSamples,sampleformat:track.format,effectivesampleformat:track.format,numsamples:track.frames},track.channels[channel]!.map(b=>element("waveblock",{start:b.start,len:b.length,blockid:b.id})));
  const clip=element("waveclip",{offset:0,trimLeft:0,trimRight:0,centShift:0,pitchAndSpeedPreset:0,rawAudioTempo:0,clipStretchRatio:1,name:track.name},[sequence,element("envelope",{numpoints:0})]);
  children.push(element("wavetrack",{name:track.name,selected:0,height:150,minimized:0,channel,linked:channel===0?2:0,rate:48000,gain:1,pan:0,sampleformat:track.format},[clip]));
 }
 if(notes.length)children.push(element("labeltrack",{name:"Recording notes",numlabels:notes.length,height:150,minimized:0,selected:0},notes.map(n=>element("label",{t:n.seconds,t1:n.seconds,title:n.text}))));
 return element("project",{xmlns:"http://audacity.sourceforge.net/xml/",version:"1.3.0",audacityversion:"3.7.9",rate:48000,sel0:0,sel1:0,h:0,zoom:86.13,vpos:0,tempo:120,timesigupper:4,timesiglower:4},children);
}
function summary(values:Int16Array|Float32Array,scale:number){
 const groups64=Math.ceil(values.length/65536),groups256=groups64*256,small=new Float32Array(groups256*3),large=new Float32Array(groups64*3);let totalSquares=0,min=Infinity,max=-Infinity;
 for(let group=0;group<groups256;group++){
  const start=group*256,end=Math.min(values.length,start+256);let lo=Infinity,hi=-Infinity,sum=0;
  for(let i=start;i<end;i++){const v=values[i]!*scale;lo=Math.min(lo,v);hi=Math.max(hi,v);sum+=v*v;}
  small[group*3]=start<values.length?lo:3.4028234663852886e38;small[group*3+1]=start<values.length?hi:-3.4028234663852886e38;small[group*3+2]=end>start?Math.sqrt(sum/(end-start)):0;
  if(end>start){totalSquares+=sum;min=Math.min(min,lo);max=Math.max(max,hi);}
 }
 for(let group=0;group<groups64;group++){
  const start=group*65536,end=Math.min(values.length,start+65536);let lo=Infinity,hi=-Infinity,sum=0;
  for(let i=start;i<end;i++){const v=values[i]!*scale;lo=Math.min(lo,v);hi=Math.max(hi,v);sum+=v*v;}
  large[group*3]=lo;large[group*3+1]=hi;large[group*3+2]=Math.sqrt(sum/(end-start));
 }
 return {min,max,rms:Math.sqrt(totalSquares/values.length),small:Buffer.from(small.buffer),large:Buffer.from(large.buffer)};
}
async function writeProject(input:NativeProjectInput){
 if(existsSync(input.output))throw Error("Native project output already exists.");closeSync(openSync(input.output,"wx",0o600));
 const db=new DatabaseSync(input.output);let child:ChildProcessWithoutNullStreams|undefined,aborted=false;
 const abort=()=>{aborted=true;child?.kill("SIGKILL");};parentPort!.on("message",message=>{if(message?.abort)abort();});
 const checkSpace=(bytes:number)=>{if(aborted)throw Error("Native project cancelled.");const s=statfsSync(input.output);if(s.bavail*s.bsize<input.reserveBytes+bytes+8*1024**2){const error=new Error("Not enough disk space to finish the native Audacity project while preserving the recording reserve.");(error as Error&{disk?:boolean}).disk=true;throw error;}};
 let success=false;let inserted=0,silent=0,reused=0,written=0,lastProgress=0;const blocks=new Map<string,number>(),tracks:Track[]=[],total=input.tracks.reduce((n,t)=>n+t.frames,0);
 try{
  db.exec("PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=-8192;PRAGMA mmap_size=0;PRAGMA application_id=1096107097;PRAGMA user_version=50790400;");
  db.exec("CREATE TABLE project(id INTEGER PRIMARY KEY,dict BLOB,doc BLOB);CREATE TABLE autosave(id INTEGER PRIMARY KEY,dict BLOB,doc BLOB);CREATE TABLE sampleblocks(blockid INTEGER PRIMARY KEY AUTOINCREMENT,sampleformat INTEGER,summin REAL,summax REAL,sumrms REAL,summary256 BLOB,summary64k BLOB,samples BLOB);BEGIN IMMEDIATE;");
  const insert=db.prepare("INSERT INTO sampleblocks(sampleformat,summin,summax,sumrms,summary256,summary64k,samples) VALUES(?,?,?,?,?,?,?)");
  for(const [index,source] of input.tracks.entries()){
   if(aborted)throw Error("Native project cancelled.");const bytes=source.format==="int16"?2:4,capacity=1048576/bytes,format=bytes===2?INT16:FLOAT,track:Track={name:clean(source.username),frames:0,format,maxSamples:capacity,channels:[[],[]]},buffer=Buffer.allocUnsafe(capacity*bytes*2);let used=0,stderr="";
   const report=()=>{lastProgress=Date.now();parentPort!.postMessage({type:"progress",speaker:source.username,index:index+1,count:input.tracks.length,seconds:(written+track.frames)/48000,totalSeconds:total/48000});};report();
   const consume=(raw:Buffer)=>{
    const count=raw.length/(bytes*2);if(!Number.isInteger(count))throw Error("Truncated decoded audio.");
    const values=bytes===2?new Int16Array(raw.buffer,raw.byteOffset,raw.length/2):new Float32Array(raw.buffer,raw.byteOffset,raw.length/4);
    for(let channel=0;channel<2;channel++){
     const mono=bytes===2?new Int16Array(count):new Float32Array(count);let zero=true;
     for(let n=0;n<count;n++){const value=values[n*2+channel]!;if(!Number.isFinite(value))throw Error("Non-finite audio sample.");mono[n]=value;if(value!==0)zero=false;}
     let id:number;
     if(zero){id=-count;silent++;}
     else{const data=Buffer.from(mono.buffer),key=format+":"+createHash("sha256").update(data).digest("hex"),known=blocks.get(key);
      if(known!==undefined){id=known;reused++;}
      else{const stats=summary(mono,bytes===2?1/32768:1);checkSpace(data.length+stats.small.length+stats.large.length+65536);id=Number(insert.run(format,stats.min,stats.max,stats.rms,stats.small,stats.large,data).lastInsertRowid);blocks.set(key,id);inserted++;}
     }
     track.channels[channel]!.push({start:track.frames,length:count,id});
    }
    track.frames+=count;if(Date.now()-lastProgress>=1000)report();
   };
   child=spawn(input.ffmpeg,["-nostdin","-v","error","-i",source.file,"-ar","48000","-ac","2","-c:a",bytes===2?"pcm_s16le":"pcm_f32le","-f",bytes===2?"s16le":"f32le","pipe:1"],{stdio:["pipe","pipe","pipe"]});deprioritize(child);parentPort!.postMessage({type:"pid",pid:child.pid});child.stdin.end();child.stderr.on("data",chunk=>stderr=(stderr+chunk).slice(-8192));const closed=once(child,"close");void closed.catch(()=>{});
   try{for await(const chunk of child.stdout){let at=0;while(at<chunk.length){const take=Math.min(buffer.length-used,chunk.length-at);chunk.copy(buffer,used,at,at+take);used+=take;at+=take;if(used===buffer.length){consume(buffer);used=0;}}}const [code]=await closed;if(code!==0)throw Error(`Cannot decode native project audio (${code}): ${stderr}`);if(used)consume(buffer.subarray(0,used));}
   finally{child.kill("SIGKILL");await closed.catch(()=>{});parentPort!.postMessage({type:"pid-closed",pid:child.pid});child=undefined;}
   if(track.frames!==source.frames)throw Error("Native project decoded length does not match the rendered track.");report();written+=track.frames;tracks.push(track);
  }
  const encoded=encodeProject(documentFor(tracks,input.notes));checkSpace(encoded.dict.length+encoded.doc.length+65536);db.prepare("INSERT INTO project VALUES(1,?,?)").run(encoded.dict,encoded.doc);db.exec("COMMIT;");const check=db.prepare("PRAGMA quick_check").get();if(check?.quick_check!=="ok")throw Error("Native project failed SQLite integrity verification.");
  success=true;return {bytes:statSync(input.output).size,blocks:inserted,silentBlocks:silent,reusedBlocks:reused};
 }finally{child?.kill("SIGKILL");db.close();if(!success)for(const suffix of ["","-journal","-wal","-shm"])rmSync(input.output+suffix,{force:true});}
}
if(parentPort){void writeProject(workerData as NativeProjectInput).then(result=>parentPort!.postMessage({type:"done",result}),error=>parentPort!.postMessage({type:"failed",message:error.message,disk:error.disk===true})).finally(()=>parentPort!.close());}
