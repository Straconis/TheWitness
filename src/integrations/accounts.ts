import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename, rm, chmod } from "node:fs/promises";
import path from "node:path";
import type { CloudProvider } from "./cloud";
export const providers:CloudProvider[]=["dropbox","google","onedrive","box"];
const endpoints={
 dropbox:{authorize:"https://www.dropbox.com/oauth2/authorize",token:"https://api.dropboxapi.com/oauth2/token",scope:"files.content.write"},
 google:{authorize:"https://accounts.google.com/o/oauth2/v2/auth",token:"https://oauth2.googleapis.com/token",scope:"https://www.googleapis.com/auth/drive.file"},
 onedrive:{authorize:"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",token:"https://login.microsoftonline.com/common/oauth2/v2.0/token",scope:"offline_access https://graph.microsoft.com/Files.ReadWrite.AppFolder"},
 box:{authorize:"https://account.box.com/api/oauth2/authorize",token:"https://api.box.com/oauth2/token",scope:""}
};
type Credentials={accessToken:string;refreshToken?:string;expiresAt:number};
type Pending={provider:CloudProvider;redirect:string;verifier:string;expiresAt:number;guildID?:string;channelID?:string;userID?:string};
export interface CloudScope {guildID:string}
const revokeEndpoints:Partial<Record<CloudProvider,{url:string;form?:boolean}>>={google:{url:"https://oauth2.googleapis.com/revoke",form:true},dropbox:{url:"https://api.dropboxapi.com/2/auth/token/revoke"}};
function tokenKey():Buffer{const value=process.env.CLOUD_TOKEN_KEY?.trim();if(!value||!/^[a-f0-9]{64}$/i.test(value))throw Error("Cloud connections are not set up on this bot yet. The host must set CLOUD_TOKEN_KEY to 64 hex characters.");return Buffer.from(value,"hex");}
function seal(data:unknown):string{const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",tokenKey(),iv),body=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);return JSON.stringify({v:1,iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),body:body.toString("base64")});}
function unseal(text:string):Credentials{const box=JSON.parse(text),decipher=createDecipheriv("aes-256-gcm",tokenKey(),Buffer.from(box.iv,"base64"));decipher.setAuthTag(Buffer.from(box.tag,"base64"));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.body,"base64")),decipher.final()]).toString());}
// Web callbacks and export workers create separate instances for the same account files.
const credentialOperations=new Map<string,Promise<unknown>>();
/** The owner's account, or one Discord server's own encrypted account when scoped. Credentials never enter manifests or browser responses. */
export class CloudAccounts {
 private async exclusive<T>(provider:CloudProvider,action:()=>Promise<T>):Promise<T>{
  const key=path.resolve(this.file(provider));
  const task=(credentialOperations.get(key)??Promise.resolve()).catch(()=>{}).then(action);
  credentialOperations.set(key,task);
  try{return await task;}finally{if(credentialOperations.get(key)===task)credentialOperations.delete(key);}
 }
 constructor(private root:string,private overrides:Partial<Record<CloudProvider,{authorize?:string;token?:string;revoke?:string}>>={},private scope?:CloudScope){if(scope&&!/^[\w-]{1,40}$/.test(scope.guildID))throw Error("Invalid server ID.");}
 private base(){return path.join(this.root,"private-accounts");}
 private directory(){return this.scope?path.join(this.base(),"servers",this.scope.guildID):this.base();}
 private pendingFile(state:string){return path.join(this.base(),"pending-"+state+".json");}
 private file(provider:CloudProvider){if(!providers.includes(provider))throw Error("Unknown cloud provider.");return path.join(this.directory(),provider+".json");}
 private config(provider:CloudProvider){const prefix=provider.toUpperCase();// The owner's environment tokens are never available to a server's scoped account.
  return {id:process.env[prefix+"_CLIENT_ID"]?.trim(),secret:process.env[prefix+"_CLIENT_SECRET"]?.trim(),access:this.scope?undefined:process.env[prefix+"_ACCESS_TOKEN"]?.trim(),refresh:this.scope?undefined:process.env[prefix+"_REFRESH_TOKEN"]?.trim()};}
 private async save(file:string,data:unknown,sealed=false){const folder=path.dirname(file);await mkdir(folder,{recursive:true,mode:0o700});await chmod(folder,0o700);await writeFile(file+".tmp",sealed?seal(data):JSON.stringify(data),{mode:0o600});await chmod(file+".tmp",0o600);await rename(file+".tmp",file);}
 private async credentials(provider:CloudProvider):Promise<Credentials|undefined>{try{const text=await readFile(this.file(provider),"utf8");return this.scope?unseal(text):JSON.parse(text);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw Error("Saved cloud credentials could not be read. Reconnect the account.");}}
 async configured(provider:CloudProvider):Promise<boolean>{return !!((await this.credentials(provider))?.accessToken||this.config(provider).access||this.config(provider).refresh);}
 async status(){return Promise.all(providers.map(async provider=>({provider,connected:await this.configured(provider),oauthReady:!!this.config(provider).id&&!!this.config(provider).secret})));}
 async connect(provider:CloudProvider,origin:string,target:{channelID?:string;userID?:string}={}):Promise<string>{
  if(this.scope)tokenKey();await this.sweepPending();
  const base=new URL(origin);if(base.pathname!=="/"||base.search||base.hash||base.username||base.password||!(base.protocol==="https:"||(base.protocol==="http:"&&["localhost","127.0.0.1"].includes(base.hostname))))throw Error("Use a public HTTPS origin or localhost HTTP.");
  const config=this.config(provider);if(!config.id||!config.secret)throw Error(`Configure ${provider.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET first.`);
  const state=randomBytes(32).toString("hex"),verifier=randomBytes(32).toString("base64url"),redirect=base.origin+"/oauth/callback";
  await this.save(this.pendingFile(state),{provider,redirect,verifier,expiresAt:Date.now()+600000,guildID:this.scope?.guildID,...target} satisfies Pending);
  const url=new URL(this.overrides[provider]?.authorize??endpoints[provider].authorize);url.search=new URLSearchParams({client_id:config.id,response_type:"code",redirect_uri:redirect,state}).toString();
  if(endpoints[provider].scope)url.searchParams.set("scope",endpoints[provider].scope);
  if(provider!=="box"){url.searchParams.set("code_challenge",createHash("sha256").update(verifier).digest("base64url"));url.searchParams.set("code_challenge_method","S256");}
  if(provider==="google"){url.searchParams.set("access_type","offline");url.searchParams.set("prompt","consent");}
  if(provider==="dropbox")url.searchParams.set("token_access_type","offline");
  return url.toString();
 }
 private async exchange(provider:CloudProvider,params:URLSearchParams,signal?:AbortSignal):Promise<Credentials>{
  const config=this.config(provider);if(!config.id||!config.secret)throw Error("Cloud OAuth client credentials are missing.");params.set("client_id",config.id);params.set("client_secret",config.secret);
  const response=await fetch(this.overrides[provider]?.token??endpoints[provider].token,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params,signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)])});
  if(!response.ok)throw Error(`Cloud authorization failed (${response.status}). Reconnect the account.`);
  const body=await response.json() as {access_token?:unknown;refresh_token?:unknown;expires_in?:unknown};if(typeof body.access_token!=="string"||!body.access_token||!Number.isFinite(Number(body.expires_in))||Number(body.expires_in)<=0)throw Error("Cloud authorization returned invalid credentials.");
  return {accessToken:body.access_token,refreshToken:typeof body.refresh_token==="string"?body.refresh_token:undefined,expiresAt:Date.now()+Number(body.expires_in)*1000};
 }
 async callback(state:string,code:string,origin:string):Promise<CloudProvider>{
  if(!/^[a-f0-9]{64}$/.test(state)||!code||code.length>8192)throw Error("Invalid account connection response.");
  const file=this.pendingFile(state);let pending:Pending;
  try{pending=JSON.parse(await readFile(file,"utf8"));await rm(file);}catch{throw Error("Account connection expired or was already used. Start again.");}
  if(pending.expiresAt<Date.now()||pending.redirect!==origin+"/oauth/callback"||!providers.includes(pending.provider))throw Error("Account connection expired or has the wrong address.");
  const params=new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:pending.redirect});if(pending.provider!=="box")params.set("code_verifier",pending.verifier);
  return this.exclusive(pending.provider,async()=>{
   const credentials=await this.exchange(pending.provider,params);const previous=await this.credentials(pending.provider);credentials.refreshToken??=previous?.refreshToken;
   if(!credentials.refreshToken)throw Error("No refresh token was supplied. Reconnect with offline access enabled.");
   await this.save(this.file(pending.provider),credentials,!!this.scope);return pending.provider;
  });
 }
 async token(provider:CloudProvider,signal?:AbortSignal):Promise<string>{
  return this.exclusive(provider,async()=>{
   signal?.throwIfAborted();const config=this.config(provider),saved=await this.credentials(provider);
   if(saved&&saved.expiresAt>Date.now()+60000)return saved.accessToken;
   const refresh=saved?.refreshToken??config.refresh;
   if(!refresh){if(!saved&&config.access)return config.access;throw Error("Cloud account needs to be connected again.");}
   const next=await this.exchange(provider,new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh}),signal);next.refreshToken??=refresh;
   await this.save(this.file(provider),next,!!this.scope);return next.accessToken;
  });
 }
 async disconnect(provider:CloudProvider){await this.exclusive(provider,async()=>{
   const saved=this.scope?await this.credentials(provider).catch(()=>undefined):undefined;await rm(this.file(provider),{force:true});
   if(saved)await this.revoke(provider,saved).catch(error=>console.warn(`[Cloud] Could not revoke ${provider} access:`,error instanceof Error?error.message:"request failed"));
  });}
 /** Best effort: the local copy is already gone, and the person can also revoke access at the provider. */
 private async revoke(provider:CloudProvider,saved:Credentials){
  const endpoint=revokeEndpoints[provider];if(!endpoint)return;const url=this.overrides[provider]?.revoke??endpoint.url,signal=AbortSignal.timeout(15000);
  const response=endpoint.form?await fetch(url,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:saved.refreshToken??saved.accessToken}),signal}):await fetch(url,{method:"POST",headers:{Authorization:`Bearer ${saved.accessToken}`},signal});
  await response.body?.cancel();if(!response.ok)throw Error(`Revoke failed (${response.status}).`);
 }
 private async sweepPending(){let names:string[];try{names=await readdir(this.base());}catch{return;}for(const name of names)if(/^pending-[a-f0-9]{64}\.json$/.test(name)){try{const pending=JSON.parse(await readFile(path.join(this.base(),name),"utf8")) as Pending;if(pending.expiresAt<Date.now())await rm(path.join(this.base(),name),{force:true});}catch{await rm(path.join(this.base(),name),{force:true});}}}
}
/** Finishes a web sign-in for whichever account started it, and reports which server it belongs to. */
export async function completeCloudConnection(root:string,state:string,code:string,origin:string):Promise<{provider:CloudProvider;guildID?:string;channelID?:string;userID?:string}>{
 if(!/^[a-f0-9]{64}$/.test(state))throw Error("Invalid account connection response.");
 let pending:Pending;try{pending=JSON.parse(await readFile(path.join(root,"private-accounts","pending-"+state+".json"),"utf8"));}catch{throw Error("Account connection expired or was already used. Start again.");}
 const provider=await new CloudAccounts(root,{},pending.guildID?{guildID:pending.guildID}:undefined).callback(state,code,origin);
 return {provider,guildID:pending.guildID,channelID:pending.channelID,userID:pending.userID};
}
