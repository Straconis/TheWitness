#!/usr/bin/env python3
"""Authenticated, read-only viewer for the fixed Witness systemd unit."""
import base64, hashlib, hmac, json, os, re, secrets, subprocess, threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

UNIT = 'the-witness.service'
WINDOWS = {'1h': '1 hour ago', '6h': '6 hours ago', '24h': '24 hours ago'}

def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return 'scrypt$' + salt.hex() + '$' + key.hex()

def valid_password(password, encoded):
    try:
        algorithm, salt, expected = encoded.split('$')
        if algorithm != 'scrypt' or len(salt) != 32 or len(expected) != 64: return False
        actual = hash_password(password, bytes.fromhex(salt)).split('$')[2]
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError): return False

def redact(message, values=()):
    for value in sorted(values, key=len, reverse=True):
        if len(value) >= 4: message = message.replace(value, '[redacted]')
    message = re.sub(r'https?://[^\s<>"\']+', lambda m: '[private link redacted]' if re.search(r'[?&](?:sig|signature|token|key|code)=', m[0], re.I) else m[0], message)
    message = re.sub(r'(?i)((?:authorization|access_token|refresh_token|discordToken|password|client_secret)\s*[\"\']?\s*[:=]\s*)(?:Bearer\s+)?[\"\']?[^\s,}\"\']+', r'\1[redacted]', message)
    return message

def read_logs(window, query, values=(), runner=subprocess.run):
    if window not in WINDOWS or len(query) > 200: raise ValueError('Invalid filter')
    result = runner(['journalctl', '--unit', UNIT, '--since', WINDOWS[window], '--lines', '1000', '--no-pager', '--output=json'], capture_output=True, text=True, timeout=10, check=True)
    entries=[]
    for line in result.stdout.splitlines():
        try:
            item=json.loads(line)
            # Defense in depth: never return a different service's records.
            if item.get('_SYSTEMD_UNIT') != UNIT: continue
            message=item.get('MESSAGE', '')
            if not isinstance(message, str): message='[non-text journal message]'
            message=redact(message, values)[:16384]
            if query.casefold() not in message.casefold(): continue
            stamp=datetime.fromtimestamp(int(item['__REALTIME_TIMESTAMP'])/1000000, timezone.utc).isoformat()
            entries.append({'time':stamp,'message':message})
        except (ValueError, KeyError, TypeError, OverflowError): continue
    return entries

PAGE='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>The Witness · Operator logs</title><style>body{font:16px system-ui;background:#10151d;color:#edf1f7;margin:0;padding:24px}main{max-width:1300px;margin:auto}h1{margin-bottom:6px}p{color:#aab8c9}label,button{margin-right:12px}input,select,button{font:inherit;padding:8px;background:#202a39;color:inherit;border:1px solid #526278;border-radius:6px}input{max-width:90%;width:300px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080c12;padding:16px;border-radius:8px;max-height:70vh;overflow:auto;font:13px ui-monospace,monospace}a{color:#8ebcff}</style><main><h1>The Witness · Operator logs</h1><p>Read-only diagnostics · times in your browser's local timezone · latest 1,000 records · credentials and private links are redacted where recognized.</p><label>Window <select id="window"><option value="1h">Last hour</option><option value="6h">Last 6 hours</option><option value="24h">Last 24 hours</option></select></label><label>Filter <input id="filter" maxlength="200" placeholder="Session, job ID, or message"></label><button id="refresh">Refresh</button><label><input id="live" type="checkbox" checked style="width:auto"> Live</label><a id="download" href="/api/download">Download shown logs</a><p id="status" role="status"></p><pre id="logs">Loading…</pre></main><script src="/viewer.js"></script></html>'''
JS='''const q=s=>document.querySelector(s);let busy=false;async function refresh(){if(busy)return;busy=true;const params=new URLSearchParams({window:q('#window').value,q:q('#filter').value});q('#download').href='/api/download?'+params;try{const response=await fetch('/api/logs?'+params,{cache:'no-store'});if(!response.ok)throw Error(response.status===401?'Login required. Reload this page.':'Could not read service logs. Check the portal service over SSH.');const entries=await response.json();q('#logs').textContent=entries.map(e=>new Date(e.time).toLocaleString()+'  '+e.message).join('\\n')||'No matching records in this window.';q('#status').textContent='Updated '+new Date().toLocaleTimeString()+' · '+entries.length+' records';}catch(error){q('#status').textContent=error.message;}finally{busy=false;}}q('#refresh').onclick=refresh;q('#window').onchange=refresh;q('#filter').onchange=refresh;setInterval(()=>{if(q('#live').checked&&!document.hidden)refresh();},5000);refresh();'''

class Portal(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self, address, username, password_hash, redactions=()):
        if not username or not password_hash or not valid_hash(password_hash): raise ValueError('Configure a username and scrypt password hash before enabling the log portal.')
        self.username=username.encode();self.password_hash=password_hash;self.redactions=redactions
        self.slots=threading.BoundedSemaphore(6)
        super().__init__(address, Handler)
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close();return
        super().process_request(request,address)
    def process_request_thread(self, request, address):
        try: super().process_request_thread(request,address)
        finally: self.slots.release()

def valid_hash(encoded):
    try:
        algorithm,salt,key=encoded.split('$')
        return algorithm=='scrypt' and len(bytes.fromhex(salt))==16 and len(bytes.fromhex(key))==32
    except (ValueError,AttributeError): return False

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup();self.connection.settimeout(15)
    def log_message(self, *_): pass  # No URLs, query text, or authentication headers in access logs.
    def send(self, status, body, content_type='text/plain; charset=utf-8', extra=()):
        body=body.encode() if isinstance(body,str) else body
        self.send_response(status)
        for name,value in [('Content-Type',content_type),('Content-Length',str(len(body))),('Cache-Control','no-store'),('X-Content-Type-Options','nosniff'),('Referrer-Policy','no-referrer'),('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")]+list(extra): self.send_header(name,value)
        self.end_headers()
        if self.command!='HEAD': self.wfile.write(body)
    def authenticate(self):
        header=self.headers.get('Authorization','')
        try:
            if not header.startswith('Basic ') or len(header)>4096: return False
            user,password=base64.b64decode(header[6:],validate=True).decode('utf-8').split(':',1)
            return hmac.compare_digest(user.encode(),self.server.username) and valid_password(password,self.server.password_hash)
        except (ValueError,UnicodeError): return False
    def do_GET(self):
        if not self.authenticate(): return self.send(401,'Operator login required.',extra=[('WWW-Authenticate','Basic realm="The Witness operator logs", charset="UTF-8"')])
        url=urlsplit(self.path)
        if url.path=='/': return self.send(200,PAGE,'text/html; charset=utf-8')
        if url.path=='/viewer.js': return self.send(200,JS,'text/javascript; charset=utf-8')
        if url.path not in ['/api/logs','/api/download']: return self.send(404,'Not found.')
        args=parse_qs(url.query);window=args.get('window',['1h'])[0];query=args.get('q',[''])[0]
        if set(args)-{'window','q'}: return self.send(400,'Invalid filter.')
        try: entries=read_logs(window,query,self.server.redactions)
        except ValueError: return self.send(400,'Invalid filter.')
        except (subprocess.SubprocessError,OSError):
            print('[Log portal] Cannot read the fixed service journal.',flush=True)
            return self.send(503,'Service log is temporarily unavailable.')
        if url.path=='/api/download': return self.send(200,'\n'.join(e['time']+' '+e['message'] for e in entries)+'\n',extra=[('Content-Disposition','attachment; filename="witness-service.log"')])
        return self.send(200,json.dumps(entries),'application/json; charset=utf-8')
    do_HEAD=do_GET
    def do_POST(self): self.send(405,'Read-only portal.',extra=[('Allow','GET, HEAD')])
    do_DELETE=do_POST
    do_PUT=do_POST
    do_PATCH=do_POST

if __name__=='__main__':
    server=Portal(('127.0.0.1',3011),os.environ.get('LOG_PORTAL_USERNAME',''),os.environ.get('LOG_PORTAL_PASSWORD_HASH',''),json.loads(os.environ.get('LOG_PORTAL_REDACT_VALUES','[]')))
    print('[Log portal] Read-only operator viewer listening on localhost:3011.',flush=True)
    server.serve_forever()
