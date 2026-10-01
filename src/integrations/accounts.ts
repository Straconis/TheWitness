import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import path from "node:path";
import type { CloudProvider } from "./cloud";
export const providers:CloudProvider[]=["dropbox","google","onedrive","box"];
const endpoints={
 dropbox:{authorize:"https://www.dropbox.com/oauth2/authorize",token:"https://api.dropboxapi.com/oauth2/token",scope:"files.content.write"},
 google:{authorize:"https://accounts.google.com/o/oauth2/v2/auth",token:"https://oauth2.googleapis.com/token",scope:"https://www.googleapis.com/auth/drive.file"},
 onedrive:{authorize:"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",token:"https://login.microsoftonline.com/common/oauth2/v2.0/token",scope:"offline_access https://graph.microsoft.com/Files.ReadWrite"},
 box:{authorize:"https://account.box.com/api/oauth2/authorize",token:"https://api.box.com/oauth2/token",scope:""}
};
type Credentials={accessToken:string;refreshToken?:string;expiresAt:number};
type Pending={provider:CloudProvider;redirect:string;verifier:string;expiresAt:number};
/** Owner accounts only. Credentials never enter manifests or browser responses. */
export class CloudAccounts {
 private locks=new Map<CloudProvider,Promise<unknown>>();
 constructor(private root:string,private overrides:Partial<Record<CloudProvider,{authorize?:string;token?:string}>>={}){}
 private directory(){return path.join(this.root,"private-accounts");}
 private file(provider:CloudProvider){if(!providers.includes(provider))throw Error("Unknown cloud provider.");return path.join(this.directory(),provider+".json");}
 private config(provider:CloudProvider){const prefix=provider.toUpperCase();return {id:process.env[prefix+"_CLIENT_ID"]?.trim(),secret:process.env[prefix+"_CLIENT_SECRET"]?.trim(),access:process.env[prefix+"_ACCESS_TOKEN"]?.trim(),refresh:process.env[prefix+"_REFRESH_TOKEN"]?.trim()};}
 private async save(file:string,data:unknown){await mkdir(this.directory(),{recursive:true,mode:0o700});await chmod(this.directory(),0o700);await writeFile(file+".tmp",JSON.stringify(data),{mode:0o600});await chmod(file+".tmp",0o600);await rename(file+".tmp",file);}
 private async credentials(provider:CloudProvider):Promise<Credentials|undefined>{try{return JSON.parse(await readFile(this.file(provider),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw Error("Saved cloud credentials could not be read. Reconnect the account.");}}
 async configured(provider:CloudProvider):Promise<boolean>{return !!((await this.credentials(provider))?.accessToken||this.config(provider).access||this.config(provider).refresh);}
 async status(){return Promise.all(providers.map(async provider=>({provider,connected:await this.configured(provider),oauthReady:!!this.config(provider).id&&!!this.config(provider).secret})));}
 async connect(provider:CloudProvider,origin:string):Promise<string>{
  const base=new URL(origin);if(base.pathname!=="/"||base.search||base.hash||base.username||base.password||!(base.protocol==="https:"||(base.protocol==="http:"&&["localhost","127.0.0.1"].includes(base.hostname))))throw Error("Use a public HTTPS origin or localhost HTTP.");
  const config=this.config(provider);if(!config.id||!config.secret)throw Error(`Configure ${provider.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET first.`);
  const state=randomBytes(32).toString("hex"),verifier=randomBytes(32).toString("base64url"),redirect=base.origin+"/oauth/callback";
  await this.save(path.join(this.directory(),"pending-"+state+".json"),{provider,redirect,verifier,expiresAt:Date.now()+600000} satisfies Pending);
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
  const file=path.join(this.directory(),"pending-"+state+".json");let pending:Pending;
  try{pending=JSON.parse(await readFile(file,"utf8"));await rm(file);}catch{throw Error("Account connection expired or was already used. Start again.");}
  if(pending.expiresAt<Date.now()||pending.redirect!==origin+"/oauth/callback"||!providers.includes(pending.provider))throw Error("Account connection expired or has the wrong address.");
  const params=new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:pending.redirect});if(pending.provider!=="box")params.set("code_verifier",pending.verifier);
  const credentials=await this.exchange(pending.provider,params);const previous=await this.credentials(pending.provider);credentials.refreshToken??=previous?.refreshToken;
  if(!credentials.refreshToken)throw Error("No refresh token was supplied. Reconnect with offline access enabled.");
  await this.save(this.file(pending.provider),credentials);return pending.provider;
 }
 async token(provider:CloudProvider,signal?:AbortSignal):Promise<string>{
  const task=(this.locks.get(provider)??Promise.resolve()).catch(()=>{}).then(async()=>{
   signal?.throwIfAborted();const config=this.config(provider),saved=await this.credentials(provider);
   if(saved&&saved.expiresAt>Date.now()+60000)return saved.accessToken;
   const refresh=saved?.refreshToken??config.refresh;
   if(!refresh){if(!saved&&config.access)return config.access;throw Error("Cloud account needs to be connected again.");}
   const next=await this.exchange(provider,new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh}),signal);next.refreshToken??=refresh;
   await this.save(this.file(provider),next);return next.accessToken;
  });this.locks.set(provider,task);try{return await task;}finally{if(this.locks.get(provider)===task)this.locks.delete(provider);}
 }
 async disconnect(provider:CloudProvider){await (this.locks.get(provider)??Promise.resolve()).catch(()=>{});await rm(this.file(provider),{force:true});}
}
