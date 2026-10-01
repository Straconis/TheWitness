import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, Server, ServerResponse } from "node:http";
import { open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { sessionIDPattern } from "../storage/sessions";

const exportPattern = /^export-([0-9a-f-]{36})$/i;
const filePattern = /^(manifest\.json|track-\d+\.(ogg|wav|flac|mp3))$/;
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export class DownloadService {
  private server?: Server;
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
    if (request.method !== "GET" && request.method !== "HEAD") return this.error(response,405,"Method not allowed.");
    const url = new URL(request.url ?? "/","http://localhost");
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
    const filename = parts[4];
    if (!filename) {
      const links = manifest.tracks.map((track: any) => `<li><a href="${route}/${track.file}${escapeHTML(url.search)}">${escapeHTML(track.username)}</a></li>`).join("");
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Witness — Downloads</title><style>body{font:18px system-ui;background:#101820;color:#edf2f7;max-width:680px;margin:70px auto;padding:24px}a{color:#9dd9ff}li{padding:12px}p{line-height:1.6}</style><h1>The Witness</h1><p>Your ${escapeHTML(String(manifest.format).toUpperCase())} speaker tracks are ready. Choose a participant to download their audio.</p><ul>${links}</ul><p>This private link expires at ${new Date(Number(expires)*1000).toISOString()}. Anyone you share it with can download these files.</p></html>`;
      response.writeHead(200,{ "Content-Type":"text/html; charset=utf-8" }); response.end(request.method === "HEAD" ? undefined : html); return;
    }
    if (!filePattern.test(filename) || (filename !== "manifest.json" && !manifest.tracks.some((track: any) => track.file === filename))) return this.error(response,404,"Not found.");
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
      response.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
      response.writeHead(status,{ "Content-Type":"application/octet-stream" });
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
    await new Promise<void>((resolve,reject) => { this.server!.once("error",reject); this.server!.listen(port,host,resolve); });
    return (this.server.address() as import("node:net").AddressInfo).port;
  }
  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeIdleConnections();
    await new Promise<void>((resolve,reject) => this.server!.close(error => error ? reject(error) : resolve()));
  }
}
