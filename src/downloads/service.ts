import { downloadName, DownloadNaming } from "./names";
import { renameSession } from "../storage/titles";
import { StorageMonitor } from "../storage/space";
import { WebSocketServer } from "ws";
import { OpusEncoder } from "@discordjs/opus";
import { browserPage } from "./browser-page";
import { dashboardPage } from "./dashboard-page";
import type { ExportFormat } from "../exports/export";
import { ExportQueue } from "../exports/jobs";
import { SettingsStore } from "../storage/settings";
import { RecordingManager } from "../recording/manager";
import { RecordingSession } from "../recording/session";
import { getSession, listSessions } from "../storage/sessions";
import { recoverSession } from "../recording/salvage";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, Server, ServerResponse } from "node:http";
import { open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { sessionIDPattern } from "../storage/sessions";

const exportPattern = /^export-([0-9a-f-]{36})$/i;
const filePattern = /^(manifest\.json|notes\.json|session\.sesx|project\.zip|transcript\.(txt|srt|vtt)|mix\.(ogg|wav|flac|mp3)|track-\d+\.(ogg|wav|flac|mp3))$/;
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export class DownloadService {
  private server?: Server;
  private sockets = new WebSocketServer({ noServer:true, maxPayload:1924 });
  private space?:StorageMonitor;
  private queue?:ExportQueue;
  private settings?:SettingsStore;
  private manager?:RecordingManager;
  attach(queue:ExportQueue,settings:SettingsStore,manager:RecordingManager,space?:StorageMonitor):void {this.space=space;this.queue=queue;this.settings=settings;this.manager=manager;}
  private liveSession(id:string):RecordingSession|undefined {return [...(this.manager?.sessions.values() ?? [])].find(session=>session.id===id);}
  private issue(route:string,lifetimeSeconds=86400):string {const expires=String(Math.floor(Date.now()/1000)+lifetimeSeconds);return `${this.publicURL}${route}?expires=${expires}&signature=${this.signature(route,expires)}`;}
  browserLink(id:string):string {if(!sessionIDPattern.test(id))throw new Error("Invalid session.");return this.issue(`/browser/${id}`);}
  jobLink(id:string):string {if(!sessionIDPattern.test(id))throw new Error("Invalid job.");return this.issue(`/job/${id}`);}
  dashboardLink(guildID:string):string {if(!/^[a-zA-Z0-9_-]{1,64}$/.test(guildID))throw new Error("Invalid server.");return this.issue(`/dashboard/${guildID}`);}
  private authorized(url:URL,route:string):boolean {
    const expires=url.searchParams.get("expires") ?? "",signature=url.searchParams.get("signature") ?? "";
    return /^\d{1,12}$/.test(expires)&&Number(expires)>Math.floor(Date.now()/1000)&&/^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(Buffer.from(signature,"hex"),Buffer.from(this.signature(route,expires),"hex"));
  }
  private html(response:ServerResponse,html:string):void {
    response.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' blob:; connect-src 'self'; worker-src blob:; media-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});response.end(html);
  }
  private json(response:ServerResponse,status:number,value:unknown):void {response.writeHead(status,{"Content-Type":"application/json"});response.end(JSON.stringify(value));}
  private async dashboard(request:import("node:http").IncomingMessage,response:ServerResponse,url:URL):Promise<void>{
    const guildID=url.pathname.slice(11);
    if(!this.queue||!this.settings||!this.manager)return this.error(response,503,"Dashboard unavailable.");
    if(request.method==="GET"){
      if(request.headers.accept?.includes("application/json"))return this.json(response,200,{settings:this.settings.get(guildID),storage:await this.space?.check().catch(()=>undefined),sessions:await listSessions(this.root,guildID)});
      return this.html(response,dashboardPage());
    }
    if(request.method!=="POST")return this.error(response,405,"Method not allowed.");
    if(request.headers.origin && request.headers.origin!==this.publicURL)return this.json(response,403,{error:"Invalid request origin."});
    if(!request.headers["content-type"]?.startsWith("application/json"))return this.json(response,415,{error:"JSON required."});
    let body="";for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>8192)return this.json(response,413,{error:"Request too large."});}
    const data=JSON.parse(body);
    try{
      if(data.action==="settings"){
        if(typeof data.autoJoin!=="boolean"||typeof data.autoRecord!=="boolean")throw new Error("Invalid settings.");
        if(data.downloadNaming!==undefined&&!["date","original"].includes(data.downloadNaming))throw new Error("Invalid download naming style.");
        await this.settings.update(guildID,{autoJoin:data.autoRecord||data.autoJoin,autoRecord:data.autoRecord,...(data.downloadNaming?{downloadNaming:data.downloadNaming}: {})});return this.json(response,200,{saved:true});
      }
      if(data.action==="title"){await this.manager.exclusive(guildID,async()=>{const active=this.manager!.sessions.get(guildID);if(active&&active.id===data.session)await active.setTitle(data.title);else await renameSession(this.root,data.session,guildID,data.title);});return this.json(response,200,{saved:true});}
      if(data.action==="export"){const job=await this.queue.enqueue(data.session,guildID,data.format as ExportFormat,data.mix===true);return this.json(response,202,{url:this.jobLink(job.id)});}
      if(data.action==="recover"){const id=await this.manager.exclusive(guildID,()=>recoverSession(this.root,data.session,guildID));return this.json(response,200,{id});}
      return this.json(response,400,{error:"Unknown action."});
    }catch(error){return this.json(response,400,{error:error instanceof Error?error.message:"Request failed."});}
  }

  private constructor(private root: string, private key: Buffer, private publicURL: string) {}

  static async create(root: string, publicURL: string): Promise<DownloadService> {
    const base = new URL(publicURL);
    if (!["http:","https:"].includes(base.protocol) || base.pathname !== "/" || base.search || base.hash || base.username || base.password) throw new Error("DOWNLOAD_PUBLIC_URL must be an HTTP(S) origin without a path or credentials.");
    const keyPath = path.join(root,"download-key");
    try { await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const key = await readFile(keyPath);
    if (key.length !== 32) throw new Error("Invalid saved download signing key.");
    return new DownloadService(await realpath(root),key,base.origin);
  }

  private signature(route: string, expires: string): string {
    return createHmac("sha256",this.key).update(`${route}\n${expires}`).digest("hex");
  }

  link(sessionID: string, exportName: string, lifetimeSeconds = 86400): string {
    if (!sessionIDPattern.test(sessionID) || !exportPattern.test(exportName) || !sessionIDPattern.test(exportName.slice(7))) throw new Error("Invalid download ID.");
    const route = `/download/${sessionID}/${exportName}`;
    const expires = String(Math.floor(Date.now()/1000)+lifetimeSeconds);
    return `${this.publicURL}${route}?expires=${expires}&signature=${this.signature(route,expires)}`;
  }

  private error(response: ServerResponse, status: number, message: string): void {
    response.writeHead(status,{ "Content-Type": "text/plain; charset=utf-8" }); response.end(message);
  }

  private async handle(request: import("node:http").IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control","no-store");
    response.setHeader("Referrer-Policy","no-referrer");
    response.setHeader("X-Content-Type-Options","nosniff");
    response.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    const url = new URL(request.url ?? "/","http://localhost");
    if(/^\/(browser|job|dashboard)\/[a-zA-Z0-9_-]{1,64}$/.test(url.pathname)){
      if(!this.authorized(url,url.pathname))return this.error(response,403,"This private link is invalid or expired.");
      if(url.pathname.startsWith("/dashboard/"))return this.dashboard(request,response,url);
      if(request.method!=="GET")return this.error(response,405,"Method not allowed.");
      const id=url.pathname.split("/")[2]!;
      if(url.pathname.startsWith("/browser/")){
        if(!this.liveSession(id))return this.error(response,404,"This recording session is no longer active.");
        return this.html(response,browserPage());
      }
      const job=this.queue?.get(id);if(!job)return this.error(response,404,"Export job not found.");
      const result=job.state==="completed"&&job.directory?this.link(job.sessionID,job.directory):undefined;
      if(request.headers.accept?.includes("application/json"))return this.json(response,200,{state:job.state,url:result,error:job.state==="failed"?"Export failed. Check the bot logs.":undefined});
      return this.html(response,`<!doctype html><html lang="en"><meta charset="utf-8"><title>The Witness export</title><style>body{font:18px system-ui;max-width:680px;margin:70px auto;padding:24px;background:#101820;color:#edf2f7}a{color:#9dd9ff}</style><h1>Your export</h1><p id="status">Preparing your recording…</p><script>async function check(){try{const response=await fetch(location.href,{headers:{Accept:'application/json'}});if(!response.ok)throw Error('Link unavailable');const data=await response.json();const status=document.querySelector('#status');status.textContent=data.state;if(data.url){const link=document.createElement('a');link.href=data.url;link.textContent='Open downloads';status.replaceChildren(link);}else if(data.state==='failed'){status.textContent=data.error;}else setTimeout(check,2000);}catch(error){document.querySelector('#status').textContent=error.message;}}check();</script></html>`);
    }
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") return this.error(response,405,"Method not allowed.");
    const parts = url.pathname.split("/");
    if ((parts.length !== 4 && parts.length !== 5) || parts[1] !== "download" || !sessionIDPattern.test(parts[2]!) || !exportPattern.test(parts[3]!) || !sessionIDPattern.test(parts[3]!.slice(7))) return this.error(response,404,"Not found.");
    const route = parts.slice(0,4).join("/");
    const expires = url.searchParams.get("expires") ?? "", supplied = url.searchParams.get("signature") ?? "";
    if (!/^\d{1,12}$/.test(expires) || Number(expires) <= Math.floor(Date.now()/1000) || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied,"hex"),Buffer.from(this.signature(route,expires),"hex"))) return this.error(response,403,"This download link is invalid or expired.");
    const directory = await realpath(path.join(this.root,parts[2]!,parts[3]!));
    if (!directory.startsWith(this.root+path.sep)) return this.error(response,404,"Not found.");
    const manifestPath = path.join(directory,"manifest.json");
    if ((await stat(manifestPath)).size > 1024*1024) throw new Error("Invalid export manifest.");
    const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
    if (!Array.isArray(manifest.tracks) || !manifest.tracks.every((track: any) => typeof track.file === "string" && filePattern.test(track.file) && typeof track.username === "string")) throw new Error("Invalid export manifest.");
    if(manifest.transcripts && (!Array.isArray(manifest.transcripts)||!manifest.transcripts.every((file:unknown)=>typeof file==="string"&&/^transcript\.(txt|srt|vtt)$/.test(file))))throw new Error("Invalid transcript files.");
    if (manifest.mix && !/^mix\.(ogg|wav|flac|mp3)$/.test(manifest.mix)) throw new Error("Invalid mixed file.");
    if (manifest.notes && manifest.notes !== "notes.json") throw new Error("Invalid notes file.");
    if(manifest.project&&manifest.project!=="project.zip")throw new Error("Invalid project file.");
    const requestedNaming=url.searchParams.get("names");
    const naming:DownloadNaming=requestedNaming==="date"||requestedNaming==="original"?requestedNaming:(this.settings&&manifest.guildID?this.settings.get(manifest.guildID).downloadNaming:undefined)??"date";
    const filename = parts[4];
    if(request.method==="POST"){
      if(filename||!this.queue)return this.error(response,405,"Method not allowed.");
      if(request.headers.origin&&request.headers.origin!==this.publicURL)return this.json(response,403,{error:"Invalid request origin."});
      if(!request.headers["content-type"]?.startsWith("application/json"))return this.json(response,415,{error:"JSON required."});
      let body="";for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>8192)return this.json(response,413,{error:"Request too large."});}
      try{
        const data=JSON.parse(body),start=Number(data.start??0),end=data.end===undefined||data.end===""?undefined:Number(data.end),baseStart=manifest.trim?.start??0,baseEnd=manifest.trim?.end;
        if(!Number.isFinite(start)||start<0||(end!==undefined&&(!Number.isFinite(end)||end<=start)))throw new Error("Choose a valid start and end time.");
        if(baseEnd!==undefined&&(baseStart+start>=baseEnd||(end!==undefined&&baseStart+end>baseEnd)))throw new Error("Trim range exceeds this shared excerpt.");
        const source=JSON.parse(await readFile(path.join(this.root,parts[2]!,"session.json"),"utf8"));
        await getSession(this.root,parts[2]!,source.guildID);
        const job=await this.queue.enqueue(parts[2]!,source.guildID,data.format??manifest.format,data.mix===true,{trimStart:baseStart+start,trimEnd:end===undefined?baseEnd:baseStart+end});
        return this.json(response,202,{url:this.jobLink(job.id)});
      }catch(error){return this.json(response,400,{error:error instanceof Error?error.message:"Cannot prepare edit."});}
    }

    if (!filename) {
      const downloadSearch=new URLSearchParams(url.searchParams);downloadSearch.set("names",naming);
      const query="?"+escapeHTML(downloadSearch.toString());
      const toggle=new URLSearchParams(downloadSearch);toggle.set("names",naming==="date"?"original":"date");
      const namesToggle=`<p>Download names: ${naming==="date"?"recording date/time (UTC)":"original filenames"}. <a href="${route}?${escapeHTML(toggle.toString())}">Switch to ${naming==="date"?"original filenames":"date/time names"}</a></p>`;
      const links = manifest.tracks.map((track: any) => `<li><a href="${route}/${track.file}${query}">${escapeHTML(track.username)}</a> <small>${escapeHTML(downloadName(track.file,manifest,naming))}</small><br><audio controls preload="none" src="${route}/${track.file}${query}&amp;preview=1"></audio></li>`).join("");
      const extras = [[manifest.project,"Download Audition project (ZIP)"],[manifest.mix,"Mixed session audio"],[manifest.notes,"Session notes"],...(manifest.transcripts??[]).map((file:string)=>[file,file])].filter(([file]) => file).map(([file,label]) => `<li><a href="${route}/${file}${query}">${label}</a></li>`).join("");
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Witness — Downloads</title><style>body{font:18px system-ui;background:#101820;color:#edf2f7;max-width:680px;margin:70px auto;padding:24px}a{color:#9dd9ff}li{padding:12px}p{line-height:1.6}</style><h1>${escapeHTML(manifest.title??"The Witness")}</h1><p>Your ${escapeHTML(String(manifest.format).toUpperCase())} speaker tracks are ready. Choose a participant to download their audio.</p>${namesToggle}<ul>${extras}${links}</ul>${this.queue?`<section><h2>Export an excerpt</h2><p>Times are in seconds from the beginning of these audio files. The original recording stays unchanged.</p><label>Start <input id="start" type="number" min="0" step="0.1" value="0"></label><label>End <input id="end" type="number" min="0" step="0.1"></label><select id="format">${["audition","ogg","wav","flac","mp3"].map(value=>`<option value="${value}">${value==="audition"?"Adobe Audition project (ZIP)":value.toUpperCase()}</option>`).join("")}</select><label><input id="mix" type="checkbox"> Include mixed audio</label><button id="edit">Prepare excerpt</button><p id="status" role="status"></p></section><script>document.querySelector('#edit').onclick=async()=>{const status=document.querySelector('#status');try{const response=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start:document.querySelector('#start').value,end:document.querySelector('#end').value,format:document.querySelector('#format').value,mix:document.querySelector('#mix').checked})});const data=await response.json();if(!response.ok)throw Error(data.error);const link=document.createElement('a');link.href=data.url;link.textContent='Open excerpt status';status.replaceChildren(link);}catch(error){status.textContent=error.message;}};</script>`:""}<p>This private link expires at ${new Date(Number(expires)*1000).toISOString()}. Anyone you share it with can download these files.</p></html>`;
      this.html(response,html); return;
    }
    if (!filePattern.test(filename) || (filename !== "manifest.json" && filename !== manifest.mix && filename !== manifest.notes && filename !== manifest.project && filename !== "session.sesx" && !manifest.transcripts?.includes(filename) && !manifest.tracks.some((track: any) => track.file === filename))) return this.error(response,404,"Not found.");
    const file = await open(path.join(directory,filename),constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) return this.error(response,404,"Not found.");
      let start = 0, end = info.size-1, status = 200;
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match || Number(match[1]) >= info.size || (match[2] && Number(match[2]) < Number(match[1]))) {
          response.setHeader("Content-Range",`bytes */${info.size}`); return this.error(response,416,"Invalid range.");
        }
        start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]),end) : end; status = 206;
        response.setHeader("Content-Range",`bytes ${start}-${end}/${info.size}`);
      }
      response.setHeader("Accept-Ranges","bytes");
      response.setHeader("Content-Length",String(Math.max(0,end-start+1)));
      response.setHeader("Content-Disposition",`${url.searchParams.get("preview")==="1"?"inline":"attachment"}; filename="${downloadName(filename,manifest,naming)}"`);
      response.writeHead(status,{ "Content-Type": ({ogg:"audio/ogg",wav:"audio/wav",flac:"audio/flac",mp3:"audio/mpeg"} as Record<string,string>)[filename.split(".").pop()!]??"application/octet-stream" });
      if (request.method === "HEAD" || !info.size) { response.end(); return; }
      await pipeline(createReadStream("",{ fd: file.fd, autoClose:false, start,end }),response);
    } finally { await file.close(); }
  }

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    this.server = createServer((request,response) => {
      void this.handle(request,response).catch(error => {
        if (response.headersSent) response.destroy();
        else this.error(response,(error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500,"Download unavailable.");
      });
    });
    this.server.on("upgrade",(request,socket,head)=>{
      const url=new URL(request.url ?? "/","http://localhost"),id=url.pathname.split("/")[2] ?? "";
      const session=this.liveSession(id);
      if(!/^\/browser\/[a-f0-9-]{36}$/i.test(url.pathname)||!session||!this.authorized(url,url.pathname)||this.sockets.clients.size>=100){socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return;}
      if(request.headers.origin && request.headers.origin!==this.publicURL){socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return;}
      this.sockets.handleUpgrade(request,socket,head,ws=>{
        const encoder=new OpusEncoder(48000,2),userID="browser-"+randomUUID(),username=(url.searchParams.get("name")??"Guest").slice(0,80);
        let frames=0,epoch=Date.now();
        const timer=setInterval(()=>{if(!this.liveSession(id))ws.close(1000,"Recording stopped");},1000);timer.unref();
        ws.on("close",()=>clearInterval(timer));ws.on("error",()=>ws.close());
        ws.on("message",(raw,isBinary)=>{
          const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer);
          if(!isBinary||bytes.length!==1924){ws.close(1008,"Invalid audio frame");return;}
          if(Date.now()-epoch>=5000){frames=0;epoch=Date.now();}if(++frames>500){ws.close(1008,"Audio rate exceeded");return;}
          try{
            const stereo=Buffer.alloc(3840);for(let sample=0;sample<960;sample++){const value=bytes.readInt16LE(4+sample*2);stereo.writeInt16LE(value,sample*4);stereo.writeInt16LE(value,sample*4+2);}
            void session.append(encoder.encode(stereo),userID,username,bytes.readUInt32LE(0),undefined,stereo).catch(()=>ws.close(1011,"Recording storage error"));
          }catch{ws.close(1008,"Invalid audio frame");}
        });
      });
    });
    await new Promise<void>((resolve,reject) => { this.server!.once("error",reject); this.server!.listen(port,host,resolve); });
    return (this.server.address() as import("node:net").AddressInfo).port;
  }
  async close(): Promise<void> {
    if (!this.server) return;
    for(const socket of this.sockets.clients)socket.terminate();
    this.server.closeIdleConnections();
    await new Promise<void>((resolve,reject) => this.server!.close(error => error ? reject(error) : resolve()));
  }
}
