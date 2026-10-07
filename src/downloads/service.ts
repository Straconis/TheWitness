import { exportProgressPage } from "./export-progress-page";
import { invitePage } from "./invite-page";
import { legalPage } from "./legal-page";
import {getServerIntro,uploadIntroChunk} from "../exports/server-intro";
import { recordingPage } from "./recording-page";
import { resolveAudioFormat, ProjectTrackFormat } from "../exports/formats";
import { transcriptionReady } from "../integrations/transcription-config";
import { editorPage } from "./editor-page";
import { waveform } from "./waveforms";
import { validateEdits } from "../exports/edits";
import { CloudAccounts } from "../integrations/accounts";
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
import { startKeepAlive } from "./keepalive";

/** One recording rarely needs more than a few remote guests; a leaked link must not flood storage. */
export const MAX_BROWSER_GUESTS = 8;

const exportPattern = /^export-([0-9a-f-]{36})$/i;
const filePattern = /^(manifest\.json|notes\.json|session\.(sesx|aup)|project\.zip|transcript\.(txt|srt|vtt)|mix\.(ogg|wav|flac|mp3|m4a)|(?:raw-)?track-\d+\.(ogg|wav|flac|mp3|m4a))$/;
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export class DownloadService {
  private server?: Server;
  private sockets = new WebSocketServer({ noServer:true, maxPayload:1924 });
  private guestCounts = new Map<string,number>();
  private activeGuests=new Map<string,Set<string>>();
  private space?:StorageMonitor;
  private queue?:ExportQueue;
  private settings?:SettingsStore;
  private manager?:RecordingManager;
  attach(queue:ExportQueue,settings:SettingsStore,manager:RecordingManager,space?:StorageMonitor):void {this.space=space;this.queue=queue;this.settings=settings;this.manager=manager;}
  private liveSession(id:string):RecordingSession|undefined {return [...(this.manager?.sessions.values() ?? [])].find(session=>session.id===id);}
  private issue(route:string,lifetimeSeconds=86400,manager=false):string {const expires=String(Math.floor(Date.now()/1000)+lifetimeSeconds);return `${this.publicURL}${route}?expires=${expires}&signature=${this.signature(route+(manager?"\nmanager":""),expires)}${manager?"&manager=1":""}`;}
  recordingLink(id:string,lifetimeSeconds=86400):string {if(!sessionIDPattern.test(id))throw new Error("Invalid session.");return this.issue(`/recording/${id}`,lifetimeSeconds);}
  browserLink(id:string):string {if(!sessionIDPattern.test(id))throw new Error("Invalid session.");return this.issue(`/browser/${id}`);}
  jobLink(id:string):string {if(!sessionIDPattern.test(id))throw new Error("Invalid job.");return this.issue(`/job/${id}`);}
  dashboardLink(guildID:string,manager=false):string {if(!/^[a-zA-Z0-9_-]{1,64}$/.test(guildID))throw new Error("Invalid server.");return this.issue(`/dashboard/${guildID}`,86400,manager);}
  private authorized(url:URL,route:string):boolean {
    if(route.startsWith("/dashboard/")&&url.searchParams.has("manager")&&url.searchParams.get("manager")!=="1")return false;
    const scoped=route+(route.startsWith("/dashboard/")&&url.searchParams.get("manager")==="1"?"\nmanager":"");
    const expires=url.searchParams.get("expires") ?? "",signature=url.searchParams.get("signature") ?? "";
    return /^\d{1,12}$/.test(expires)&&Number(expires)>Math.floor(Date.now()/1000)&&/^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(Buffer.from(signature,"hex"),Buffer.from(this.signature(scoped,expires),"hex"));
  }
  private html(response:ServerResponse,html:string):void {
    response.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' blob:; connect-src 'self'; worker-src blob:; media-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});response.end(html.replace(/<title>/i,'<link rel="icon" type="image/png" href="/assets/witness-icon.png"><link rel="apple-touch-icon" href="/assets/witness-icon.png"><title>'));
  }
  private json(response:ServerResponse,status:number,value:unknown):void {response.writeHead(status,{"Content-Type":"application/json"});response.end(JSON.stringify(value));}
  /** Collect bytes, not decoded chunks, so multi-byte characters split across chunks survive. */
  private async readBody(request:import("node:http").IncomingMessage,limit:number):Promise<string|undefined>{
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of request){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=buffer.length;if(size>limit)return undefined;chunks.push(buffer);}
    return Buffer.concat(chunks).toString("utf8");
  }
  private async dashboard(request:import("node:http").IncomingMessage,response:ServerResponse,url:URL):Promise<void>{
    const guildID=url.pathname.slice(11),canManage=url.searchParams.get("manager")==="1";
    if(!this.queue||!this.settings||!this.manager)return this.error(response,503,"Dashboard unavailable.");
    if(request.method==="GET"){
      if(request.headers.accept?.includes("application/json"))return this.json(response,200,{canManage,intro:await getServerIntro(this.root,guildID),integrations:{transcription:transcriptionReady(),cloud:await new CloudAccounts(this.root).status()},settings:this.settings.get(guildID),storage:await this.space?.check().catch(()=>undefined),syncFeedURL:this.issue(`/sync-feed/${guildID}`,31536000),sessions:await listSessions(this.root,guildID)});
      return this.html(response,dashboardPage(canManage));
    }
    if(request.method!=="POST")return this.error(response,405,"Method not allowed.");
    if(request.headers.origin && request.headers.origin!==this.publicURL)return this.json(response,403,{error:"Invalid request origin."});
    if(!request.headers["content-type"]?.startsWith("application/json"))return this.json(response,415,{error:"JSON required."});
    const body=await this.readBody(request,1048576);if(body===undefined)return this.json(response,413,{error:"Request too large."});
    try{
      const data=JSON.parse(body);
      if(["settings","upload-intro"].includes(data.action)&&!canManage)return this.json(response,403,{error:"Use a manager dashboard link from /dashboard to change server settings or intros."});
      if(data.action==="upload-intro")return this.json(response,200,await uploadIntroChunk(this.root,guildID,data));
      if(data.action==="settings"){
        if(typeof data.autoJoin!=="boolean"||typeof data.autoRecord!=="boolean")throw new Error("Invalid settings.");
        if(data.downloadNaming!==undefined&&!["date","date-channel","original"].includes(data.downloadNaming))throw new Error("Invalid download naming style.");
        await this.settings.update(guildID,{autoJoin:data.autoRecord||data.autoJoin,autoRecord:data.autoRecord,...(data.downloadNaming?{downloadNaming:data.downloadNaming}: {}),...(data.sync!==undefined?{sync:data.sync}:{})});return this.json(response,200,{saved:true});
      }
      if(data.action==="title"){await this.manager.exclusive(guildID,async()=>{const active=this.manager!.sessions.get(guildID);if(active&&active.id===data.session)await active.setTitle(data.title);else await renameSession(this.root,data.session,guildID,data.title);});return this.json(response,200,{saved:true});}
      if(data.action==="export"){const job=await this.queue.enqueue(data.session,guildID,data.format as ExportFormat,data.mix===true,{transcribe:data.transcribe===true,upload:data.upload||undefined});return this.json(response,202,{url:this.jobLink(job.id)});}
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
    if (["/assets/witness-icon.png","/favicon.ico","/apple-touch-icon.png"].includes(url.pathname)) {
      if(request.method!=="GET"&&request.method!=="HEAD")return this.error(response,405,"Method not allowed.");
      const ico=url.pathname==="/favicon.ico",icon=await readFile(path.resolve(__dirname,"../../docs/images/",ico?"favicon.ico":"witness-icon.png"));
      response.writeHead(200,{"Content-Type":ico?"image/vnd.microsoft.icon":"image/png","Content-Length":icon.length});
      response.end(request.method==="HEAD"?undefined:icon);return;
    }
    if (url.pathname === "/assets/witness-banner.png") {
      if (request.method !== "GET" && request.method !== "HEAD") return this.error(response,405,"Method not allowed.");
      const banner = await readFile(path.resolve(__dirname,"../../docs/images/discord_banner.png"));
      response.writeHead(200,{"Content-Type":"image/png","Content-Length":banner.length});
      response.end(request.method === "HEAD" ? undefined : banner);
      return;
    }
    if(/^\/sync-feed\/[0-9]{1,25}$/.test(url.pathname)){
      if(request.method!=="GET")return this.error(response,405,"Method not allowed.");
      if(!this.authorized(url,url.pathname))return this.error(response,403,"Sync pairing link is invalid or expired.");
      const guildID=url.pathname.split("/")[2]!;
      const slate=this.manager?.syncSessions.get(guildID);
      const cues=(slate?.cues??[]).filter(cue=>cue.targetUTC>Date.now()-600000);
      return this.json(response,200,{version:1,serverUTC:Date.now(),cues});
    }
    if (["/invite", "/invite/"].includes(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") return this.error(response,405,"Method not allowed.");
      return this.html(response, request.method === "HEAD" ? "" : invitePage());
    }
    if (["/terms", "/privacy", "/terms/", "/privacy/"].includes(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") return this.error(response,405,"Method not allowed.");
      return this.html(response, request.method === "HEAD" ? "" : legalPage(url.pathname.startsWith("/terms") ? "terms" : "privacy"));
    }
    if(url.pathname==="/oauth/callback"){
      if(request.method!=="GET")return this.error(response,405,"Method not allowed.");
      try{if(url.searchParams.has("error"))throw Error("Account connection was declined. Start again from the owner command line.");const provider=await new CloudAccounts(this.root).callback(url.searchParams.get("state")??"",url.searchParams.get("code")??"",this.publicURL);return this.html(response,`<!doctype html><html lang="en"><meta charset="utf-8"><title>Account connected</title><h1>${provider} connected</h1><p>You can close this window. Uploads remain opt-in.</p></html>`);}
      catch(error){return this.error(response,400,error instanceof Error?error.message:"Account connection failed.");}
    }
    if(url.pathname.startsWith("/recording/")){
      const id=url.pathname.slice(11);
      if(!sessionIDPattern.test(id))return this.error(response,404,"Recording not found.");
      if(!this.authorized(url,url.pathname))return this.error(response,403,"This private link is invalid or expired.");
      if(!this.queue)return this.error(response,503,"Downloads unavailable.");
      const metadata=JSON.parse(await readFile(path.join(this.root,id,"session.json"),"utf8"));
      const saved=await getSession(this.root,id,metadata.guildID);
      if(saved.state!=="completed"||!saved.tracks.length)return this.error(response,400,"This recording has no completed audio tracks to download.");
      if(request.method==="GET")return this.html(response,recordingPage(saved,transcriptionReady(),await getServerIntro(this.root,saved.guildID)));
      if(request.method!=="POST")return this.error(response,405,"Method not allowed.");
      if(request.headers.origin&&request.headers.origin!==this.publicURL)return this.json(response,403,{error:"Invalid request origin."});
      if(!request.headers["content-type"]?.startsWith("application/json"))return this.json(response,415,{error:"JSON required."});
      const body=await this.readBody(request,800000);if(body===undefined)return this.json(response,413,{error:"Request too large."});
      try{
        const data=JSON.parse(body);if(data.action==="upload-intro")return this.json(response,403,{error:"Server intros can only be uploaded through a manager dashboard link from /dashboard."});resolveAudioFormat(data.format,data.trackFormat);
        const job=await this.queue.enqueue(id,saved.guildID,data.format,data.mix===true,{targetLUFS:data.targetLUFS,maxTruePeakDBTP:data.maxTruePeakDBTP,normalizeAudio:data.normalizeAudio===true,normalizeIntro:data.normalizeIntro===true,trimSilence:data.trimSilence===true,trimEndSilence:data.trimEndSilence===true,silenceSeconds:data.silenceSeconds,includeRaw:data.includeRaw===true,includeIntro:data.includeIntro===true,excludeFromMix:data.excludeFromMix,trackFormat:data.trackFormat as ProjectTrackFormat,transcribe:data.transcribe===true});
        const jobURL=new URL(this.jobLink(job.id));if(data.mixedOnly===true&&data.mix===true&&!["audition","audacity"].includes(data.format))jobURL.searchParams.set("mixed","1");
        return this.json(response,202,{url:jobURL.toString()});
      }catch(error){return this.json(response,400,{error:error instanceof Error?error.message:"Export failed."});}
    }
    if(/^\/(browser|job|dashboard)\/[a-zA-Z0-9_-]{1,64}$/.test(url.pathname)){
      if(!this.authorized(url,url.pathname))return this.error(response,403,"This private link is invalid or expired.");
      if(url.pathname.startsWith("/dashboard/"))return this.dashboard(request,response,url);
      if(request.method!=="GET"&&!(url.pathname.startsWith("/job/")&&request.method==="POST"))return this.error(response,405,"Method not allowed.");
      const id=url.pathname.split("/")[2]!;
      if(url.pathname.startsWith("/browser/")){
        if(!this.liveSession(id))return this.error(response,404,"This recording session is no longer active.");
        return this.html(response,browserPage());
      }
      const job=this.queue?.get(id);if(!job)return this.error(response,404,"Export job not found.");
      if(request.method==="POST"){
        if(request.headers.origin&&request.headers.origin!==this.publicURL)return this.json(response,403,{error:"Invalid request origin."});
        if(!request.headers["content-type"]?.startsWith("application/json"))return this.json(response,415,{error:"JSON required."});
        const body=await this.readBody(request,1024);if(body===undefined)return this.json(response,413,{error:"Request too large."});
        try{const data=JSON.parse(body);if(data.action==="cancel"){await this.queue!.cancel(job.id,job.guildID);return this.json(response,200,{state:this.queue!.get(job.id)!.state});}if(data.action==="retry"){const next=await this.queue!.retry(job.id,job.guildID);const retryURL=new URL(this.jobLink(next.id));if(url.searchParams.get("mixed")==="1")retryURL.searchParams.set("mixed","1");return this.json(response,202,{url:retryURL.toString()});}return this.json(response,400,{error:"Unknown action."});}
        catch(error){return this.json(response,400,{error:error instanceof Error?error.message:"Job action failed."});}
      }
      let result=job.state==="completed"&&job.directory?this.link(job.sessionID,job.directory):undefined;
      if(result&&url.searchParams.get("mixed")==="1"&&job.mix&&!["audition","audacity"].includes(job.format)){const target=new URL(result);target.pathname+="/mix."+(job.format==="aac"?"m4a":job.format);result=target.toString();}
      const exportURL=job.state==="completed"&&job.directory?this.link(job.sessionID,job.directory):undefined;
      const mixerURL=exportURL?new URL(job.sourceExport?this.link(job.sessionID,job.sourceExport):exportURL):undefined;
      mixerURL?.searchParams.set("editor","1");
      let downloadURL=result&&url.searchParams.get("mixed")==="1"?result:undefined;
      if(result&&["audacity","audition"].includes(job.format)){const target=new URL(result);target.pathname+="/project.zip";downloadURL=target.toString();}
      const position=this.queue!.position(job.id);
      if(request.headers.accept?.includes("application/json"))return this.json(response,200,{id:job.id,state:job.state,stage:position?(job.stage?.startsWith("Waiting for disk space")?`${job.stage} Queue position ${position}.`:`Waiting in the export queue: position ${position}`):job.stage,position,url:result,downloadURL,exportURL,mixerURL:mixerURL?.toString(),recordingURL:this.recordingLink(job.sessionID),error:job.state==="failed"?"Export failed. Check the bot logs.":undefined});
      return this.html(response,exportProgressPage());
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
    if (manifest.mix && !/^mix\.(ogg|wav|flac|mp3|m4a)$/.test(manifest.mix)) throw new Error("Invalid mixed file.");
    if (manifest.notes && manifest.notes !== "notes.json") throw new Error("Invalid notes file.");
    if(manifest.project&&manifest.project!=="project.zip")throw new Error("Invalid project file.");
    // Raw-source excerpt offsets cannot describe timelines changed by edits, intros or silence cuts.
    const sourceExcerptAllowed=!manifest.edits&&!manifest.intro&&!manifest.silenceCuts?.length&&!manifest.trailingSilenceCut;
    // Older exports predate channel metadata; read it from the authorized source session.
    if(manifest.guildID&&(!manifest.channelName||!manifest.channelID)){
      try{const source=await getSession(this.root,parts[2]!,manifest.guildID);manifest.channelName??=source.channelName;manifest.channelID??=source.channelID;}
      catch{ /* Existing authorized downloads remain usable if source metadata is unavailable. */ }
    }
    const requestedNaming=url.searchParams.get("names");
    const naming:DownloadNaming=requestedNaming==="date"||requestedNaming==="date-channel"||requestedNaming==="original"?requestedNaming:(this.settings&&manifest.guildID?this.settings.get(manifest.guildID).downloadNaming:undefined)??"date";
    const filename = parts[4];
    if(!filename&&request.method==="GET"&&url.searchParams.get("view")==="editor"){
      const waves:Record<string,unknown>={};for(const track of manifest.tracks){const id=/^track-(\d+)\./.exec(track.file)?.[1];if(!id)throw Error("Invalid editor track.");waves[id]=await waveform(path.join(directory,track.file));}
      let edits:unknown;try{edits=JSON.parse(await readFile(path.join(directory,"editor-state.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      if(manifest.notes)manifest.notesData=JSON.parse(await readFile(path.join(directory,"notes.json"),"utf8"));return this.json(response,200,{manifest,waves,edits});
    }
    if(!filename&&request.method==="GET"&&url.searchParams.get("editor")==="1")return this.html(response,editorPage());
    if(request.method==="POST"){
      if(filename||!this.queue)return this.error(response,405,"Method not allowed.");
      if(request.headers.origin&&request.headers.origin!==this.publicURL)return this.json(response,403,{error:"Invalid request origin."});
      if(!request.headers["content-type"]?.startsWith("application/json"))return this.json(response,415,{error:"JSON required."});
      const body=await this.readBody(request,1048576);if(body===undefined)return this.json(response,413,{error:"Request too large."});
      try{
        const data=JSON.parse(body);
        if(data.action==="save-edit"||data.action==="editor-export"){
          validateEdits(data.edits,manifest.tracks.map((track:any)=>Number(/^track-(\d+)\./.exec(track.file)?.[1])));
          if(data.action==="save-edit"){const temporary=path.join(directory,"editor-state-"+randomUUID()+".tmp");await writeFile(temporary,JSON.stringify(data.edits));await import("node:fs/promises").then(fs=>fs.rename(temporary,path.join(directory,"editor-state.json")));return this.json(response,200,{saved:true});}
          const job=await this.queue.enqueue(parts[2]!,manifest.guildID,data.format??"wav",data.mix===true,{sourceExport:parts[3]!,edits:data.edits,transcribe:data.transcribe===true});return this.json(response,202,{url:this.jobLink(job.id)});
        }
        if(!sourceExcerptAllowed)throw new Error("This export has timeline changes. Use the multitrack editor to excerpt these files, or choose an excerpt from an unprocessed export.");
        const start=Number(data.start??0),end=data.end===undefined||data.end===""?undefined:Number(data.end),baseStart=manifest.trim?.start??0,baseEnd=manifest.trim?.end;
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
      const namingOptions:Array<[DownloadNaming,string]>=[["date","Date only (UTC)"],["date-channel","Date + channel (UTC)"],["original","Original filenames"]];
      const namesToggle=`<p>ZIP download names: ${namingOptions.map(([style,label])=>{const search=new URLSearchParams(downloadSearch);search.set("names",style);return style===naming?`<strong>${label}</strong>`:`<a href="${route}?${escapeHTML(search.toString())}">${label}</a>`;}).join(" · ")}</p>`;
      if(manifest.rawTracks&&(!Array.isArray(manifest.rawTracks)||!manifest.rawTracks.every((track:any)=>/^raw-track-\d+\.flac$/.test(track.file)&&typeof track.username==="string")))throw Error("Invalid original track manifest.");
      const links = manifest.tracks.map((track: any) => `<li><a href="${route}/${track.file}${query}">${escapeHTML(track.username)}</a> <small>${escapeHTML(downloadName(track.file,manifest,naming))}</small><br><audio controls preload="metadata" src="${route}/${track.file}${query}&amp;preview=1"></audio></li>`).join("");
      const rawLinks=(manifest.rawTracks??[]).map((track:any)=>`<li><a href="${route}/${escapeHTML(track.file)}${query}">Uncut original: ${escapeHTML(track.username)}</a> (FLAC)</li>`).join("");
      const extras = [[manifest.project,"Download project (ZIP)"],[manifest.mix,"Mixed session audio"],[manifest.notes,"Session notes"],...(manifest.transcripts??[]).map((file:string)=>[file,file])].filter(([file]) => file).map(([file,label]) => `<li><a href="${route}/${file}${query}">${label}</a></li>`).join("");
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Witness — Downloads</title><style>body{font:18px system-ui;background:#101820;color:#edf2f7;max-width:680px;margin:70px auto;padding:24px}a{color:#9dd9ff}li{padding:12px}p{line-height:1.6}</style><h1>${escapeHTML(manifest.title??"The Witness")}</h1><p>Your ${escapeHTML(String(manifest.format).toUpperCase())} speaker tracks are ready. Choose a participant to download their audio.</p>${namesToggle}<p><a href="${escapeHTML(this.recordingLink(parts[2]!))}">Choose another format or mixdown speakers</a></p><p><a href="${route}${query}&amp;editor=1">Open multitrack editor</a></p><ul>${extras}${links}${rawLinks}</ul>${this.queue&&sourceExcerptAllowed?`<section><h2>Export an excerpt</h2><p>Times are in seconds from the beginning of these audio files. The original recording stays unchanged.</p><label>Start <input id="start" type="number" min="0" step="0.1" value="0"></label><label>End <input id="end" type="number" min="0" step="0.1"></label><select id="format">${["audition","audacity","ogg","wav","flac","mp3","aac"].map(value=>`<option value="${value}">${value==="audition"?"Adobe Audition project (ZIP)":value==="audacity"?"Audacity import project (ZIP)":value.toUpperCase()}</option>`).join("")}</select><label><input id="mix" type="checkbox"> Include mixed audio</label><button id="edit">Prepare excerpt</button><p id="status" role="status"></p></section><script>document.querySelector('#edit').onclick=async()=>{const status=document.querySelector('#status');try{const response=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start:document.querySelector('#start').value,end:document.querySelector('#end').value,format:document.querySelector('#format').value,mix:document.querySelector('#mix').checked})});const data=await response.json();if(!response.ok)throw Error(data.error);const link=document.createElement('a');link.href=data.url;link.textContent='Open excerpt status';status.replaceChildren(link);}catch(error){status.textContent=error.message;}};</script>`:this.queue?"<p>This export has timeline changes. Use the multitrack editor to make an excerpt from these files.</p>":""}<p>This private link expires at ${new Date(Number(expires)*1000).toISOString()}. Anyone you share it with can download these files.</p></html>`;
      this.html(response,html); return;
    }
    if (!filePattern.test(filename) || (filename !== "manifest.json" && filename !== manifest.mix && filename !== manifest.notes && filename !== manifest.project && filename !== "session.sesx" && !manifest.transcripts?.includes(filename) && !manifest.tracks.some((track: any) => track.file === filename)&&!manifest.rawTracks?.some((track:any)=>track.file===filename))) return this.error(response,404,"Not found.");
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
      response.writeHead(status,{ "Content-Type": ({ogg:"audio/ogg",wav:"audio/wav",flac:"audio/flac",mp3:"audio/mpeg",m4a:"audio/mp4"} as Record<string,string>)[filename.split(".").pop()!]??"application/octet-stream" });
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
      let url:URL;
      try{url=new URL(request.url ?? "/","http://localhost");}
      catch{socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");return;}
      const id=url.pathname.split("/")[2] ?? "";
      const session=this.liveSession(id);
      if(!/^\/browser\/[a-f0-9-]{36}$/i.test(url.pathname)||!session||!this.authorized(url,url.pathname)||this.sockets.clients.size>=100){socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return;}
      if(request.headers.origin && request.headers.origin!==this.publicURL){socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return;}
      if((this.guestCounts.get(id)??0)>=MAX_BROWSER_GUESTS){socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");return;}
      const token=url.searchParams.get("guest")??randomBytes(16).toString("hex"),username=(url.searchParams.get("name")??"Guest").replace(/[\x00-\x1f\x7f]/g,"").trim();
      if(!/^[a-f0-9]{32}$/.test(token)||!username||username.length>80){socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");return;}
      if(this.activeGuests.get(id)?.has(token)){socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");return;}
      let userID:string;try{userID=session.claimBrowserGuest(token);}catch{socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");return;}
      this.sockets.handleUpgrade(request,socket,head,ws=>{
        const guests=this.activeGuests.get(id)??new Set<string>();guests.add(token);this.activeGuests.set(id,guests);
        ws.once("close",()=>{guests.delete(token);if(!guests.size)this.activeGuests.delete(id);});
        this.guestCounts.set(id,(this.guestCounts.get(id)??0)+1);
        startKeepAlive(ws);
        ws.on("close",()=>{const left=(this.guestCounts.get(id)??1)-1;if(left>0)this.guestCounts.set(id,left);else this.guestCounts.delete(id);});
        const encoder=new OpusEncoder(48000,2);
        let firstFrame=true,frames=0,epoch=Date.now();
        const timer=setInterval(()=>{if(!this.liveSession(id))ws.close(1000,"Recording stopped");},1000);timer.unref();
        ws.on("close",()=>clearInterval(timer));ws.on("error",()=>ws.close());
        ws.on("message",(raw,isBinary)=>{
          const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer);
          if(!isBinary||bytes.length!==1924){ws.close(1008,"Invalid audio frame");return;}
          if(Date.now()-epoch>=5000){frames=0;epoch=Date.now();}if(++frames>500){ws.close(1008,"Audio rate exceeded");return;}
          try{
            const stereo=Buffer.alloc(3840);for(let sample=0;sample<960;sample++){const value=bytes.readInt16LE(4+sample*2);stereo.writeInt16LE(value,sample*4);stereo.writeInt16LE(value,sample*4+2);}
            const packet=encoder.encode(stereo),pcmEpoch=firstFrame;firstFrame=false;
            void session.append(packet,userID,username,bytes.readUInt32LE(0),undefined,stereo,pcmEpoch).catch(()=>ws.close(1011,"Recording storage error"));
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
