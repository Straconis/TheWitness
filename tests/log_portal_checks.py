import base64, importlib.util, json, pathlib, subprocess, threading, unittest, urllib.request, urllib.error
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('portal',pathlib.Path(__file__).parents[1]/'scripts/log-portal.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class Checks(unittest.TestCase):
 def test_authentication_and_routes(self):
  with self.assertRaises(ValueError):p.Portal(('127.0.0.1',0),'','')
  server=p.Portal(('127.0.0.1',0),'operator',p.hash_password('correct-password'));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   url='http://127.0.0.1:'+str(server.server_port)
   def request(route,auth=None,method='GET'):
    headers={'Authorization':'Basic '+base64.b64encode(auth.encode()).decode()} if auth else {}
    try:return urllib.request.urlopen(urllib.request.Request(url+route,headers=headers,method=method))
    except urllib.error.HTTPError as e:return e
   for route in ['/','/viewer.js','/api/logs','/api/download']:
    self.assertEqual(request(route).status,401);self.assertEqual(request(route,'operator:wrong-password').status,401)
   response=request('/','operator:correct-password');self.assertEqual(response.status,200);self.assertEqual(response.headers['Cache-Control'],'no-store');self.assertIn('frame-ancestors',response.headers['Content-Security-Policy'])
   with patch.object(p,'read_logs',return_value=[{'time':'2026-10-07T00:00:00Z','message':'<script>bad</script>'}]) as reader:
    response=request('/api/logs?window=6h&q=session','operator:correct-password');self.assertEqual(response.status,200);reader.assert_called_with('6h','session',(),view='all')
    response=request('/api/logs?view=failures','operator:correct-password');self.assertEqual(response.status,200);reader.assert_called_with('1h','',(),view='failures')
    self.assertEqual(request('/api/logs?unit=ssh.service','operator:correct-password').status,400)
    self.assertEqual(request('/api/logs','operator:correct-password','POST').status,405)
    self.assertEqual(request('/api/download','operator:correct-password').status,200)
   with patch.object(p,'read_logs',side_effect=subprocess.CalledProcessError(1,['journalctl'],stderr='secret')):
    response=request('/api/logs','operator:correct-password');self.assertEqual(response.status,503);self.assertNotIn(b'secret',response.read())
   self.assertNotIn('innerHTML',p.JS)
  finally:server.shutdown();server.server_close();thread.join()
 def test_systemd_failure_records_and_forged_units(self):
  records=[
   {'_SYSTEMD_UNIT':'init.scope','_PID':'1','UNIT':p.UNIT,'MESSAGE':"Failed with result 'oom-kill'."},
   {'_SYSTEMD_UNIT':'init.scope','_PID':'1','UNIT':p.UNIT,'MESSAGE':'Main process exited, code=killed, status=9/KILL'},
   {'_SYSTEMD_UNIT':'systemd-coredump@123.service','COREDUMP_UNIT':p.UNIT,'MESSAGE':'Process dumped core.'},
   {'_SYSTEMD_UNIT':'ssh.service','_PID':'45','UNIT':p.UNIT,'MESSAGE':'Forged failed message'},
   {'_SYSTEMD_UNIT':'systemd-coredump-imposter.service','COREDUMP_UNIT':p.UNIT,'MESSAGE':'Forged core'},
   {'_SYSTEMD_UNIT':'init.scope','_PID':'1','UNIT':'other.service','MESSAGE':'Other failure'},
   {'_SYSTEMD_UNIT':'systemd-coredump@123.service','COREDUMP_UNIT':'other.service','MESSAGE':'Other core'}]
  for item in records:item['__REALTIME_TIMESTAMP']='1000000'
  def runner(*args,**kwargs):return subprocess.CompletedProcess([],0,'\n'.join(json.dumps(i) for i in records),'')
  for view in ['all','failures']:
   self.assertEqual([e['message'] for e in p.read_logs('1h','',runner=runner,view=view)],[r['MESSAGE'] for r in records[:3]])
 def test_failure_view_keeps_errors_and_stack_context(self):
  messages=[('Connected',6),('[Export] Error: encoder failed',6),('    at exportSession (export.js:1:2)',6),('Export completed',6),('Journal critical event',2),('Ordinary warning',4)]
  records=[{'_SYSTEMD_UNIT':p.UNIT,'MESSAGE':message,'PRIORITY':str(priority),'__REALTIME_TIMESTAMP':'1000000'} for message,priority in messages]
  def runner(*args,**kwargs):return subprocess.CompletedProcess([],0,'\n'.join(json.dumps(i) for i in records),'')
  entries=p.read_logs('1h','',runner=runner,view='failures')
  self.assertEqual([e['message'] for e in entries],[messages[i][0] for i in [1,2,4]])
  with self.assertRaises(ValueError):p.read_logs('1h','',runner=runner,view='invalid')
 def test_refresh_preserves_login_and_updates_private_values(self):
  import tempfile, os
  installer=(pathlib.Path(__file__).parents[1]/'scripts/enable-log-portal.sh').read_text()
  code=installer.split("<<'PY'\n",1)[1].split('\nPY',1)[0]
  self.assertNotIn('exec_module',code)
  with tempfile.TemporaryDirectory() as root:
   config=pathlib.Path(root)/'portal.env';source=pathlib.Path(root)/'bot.env'
   password_hash=p.hash_password('unchanged-password')
   config.write_text('LOG_PORTAL_USERNAME=operator\nLOG_PORTAL_PASSWORD_HASH='+password_hash+'\nLOG_PORTAL_REDACT_VALUES="[]"\n')
   source.write_text('DISCORD_TOKEN=new-test-token\nBOT_SECRET="path\\with\\slashes$"\nNOT_SECRET=fixture\nexport PRIVATE_KEY="BEGIN KEY\nPRIVATE-CONTENT\nEND KEY"\nOTHER_TOKEN=unquoted-value # comment\nESCAPED_SECRET="first\\nsecond"\n')
   code=code.replace('/etc/the-witness-log-portal.env',str(config)).replace('/opt/the-witness/.env',str(source))
   result=subprocess.run(['python3','-','--refresh-redactions'],input=code,capture_output=True,text=True,check=True)
   body=config.read_text();self.assertIn('LOG_PORTAL_PASSWORD_HASH='+password_hash,body)
   self.assertIn('LOG_PORTAL_USERNAME=operator',body);self.assertEqual(config.stat().st_mode&0o777,0o600)
   values=json.loads(json.loads(body.split('LOG_PORTAL_REDACT_VALUES=',1)[1].strip()))
   self.assertIn('new-test-token',values);self.assertIn('path\\with\\slashes$',values)
   self.assertIn('BEGIN KEY\nPRIVATE-CONTENT\nEND KEY',values);self.assertIn('PRIVATE-CONTENT',values)
   self.assertIn('unquoted-value',values);self.assertIn('first\nsecond',values)
   self.assertNotIn('PRIVATE-CONTENT',p.redact('PRIVATE-CONTENT',values))
   self.assertNotIn('new-test-token',result.stdout)
 def test_refresh_missing_configuration_is_actionable(self):
  import tempfile
  installer=(pathlib.Path(__file__).parents[1]/'scripts/enable-log-portal.sh').read_text()
  code=installer.split("<<'PY'\n",1)[1].split('\nPY',1)[0]
  with tempfile.TemporaryDirectory() as root:
   code=code.replace('/etc/the-witness-log-portal.env',str(pathlib.Path(root)/'missing.env'))
   result=subprocess.run(['python3','-','--refresh-redactions'],input=code,capture_output=True,text=True)
   self.assertNotEqual(result.returncode,0);self.assertIn('run enable-log-portal.sh setup first',result.stderr)
   self.assertNotIn('Traceback',result.stderr)
 def test_full_setup_keeps_existing_cloudflare_snippet(self):
  import tempfile
  installer=(pathlib.Path(__file__).parents[1]/'scripts/enable-log-portal.sh').read_text()
  template=installer.split("<<'NGINX'\n",1)[1].split('\nNGINX',1)[0]
  code=installer.split("<<'PYIP'\n",1)[1].split('\nPYIP',1)[0]
  with tempfile.TemporaryDirectory() as root:
   site=pathlib.Path(root)/'site';site.write_text(template)
   code=code.replace('/etc/nginx/sites-available/the-witness-logs',str(site))
   subprocess.run(['python3','-'],input=code,text=True,check=True)
   text=site.read_text();self.assertEqual(text.count('include /etc/nginx/snippets/the-witness-cloudflare-real-ip.conf;'),2)
   self.assertIn('proxy_set_header Authorization $http_authorization;',text)
   self.assertIn('limit_req zone=witness_logs',text)
 def test_installer_username_prompt_on_a_real_terminal(self):
  import os, pty, fcntl, termios
  installer=(pathlib.Path(__file__).parents[1]/'scripts/enable-log-portal.sh').read_text()
  start=installer.index("with open('/dev/tty','w')")
  fragment=installer[start:installer.index('if not username.isascii()',start)]
  fragment='\n'.join(line[1:] if line.startswith(' ') else line for line in fragment.splitlines())
  master,slave=pty.openpty()
  def controlling_terminal():
   os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
  child=subprocess.Popen(['python3','-c',fragment+"\nprint('RESULT:'+username)"],stdin=slave,stdout=slave,stderr=slave,preexec_fn=controlling_terminal)
  os.close(slave);os.write(master,b'operator\n');output=b''
  try:
   while True:
    try:
     data=os.read(master,4096)
     if not data:break
     output+=data
    except OSError:break
   self.assertEqual(child.wait(timeout=5),0,output);self.assertIn(b'RESULT:operator',output)
  finally:os.close(master);child.kill() if child.poll() is None else None
 def test_reader_scope_and_redaction(self):
  records=[{'_SYSTEMD_UNIT':'ssh.service','MESSAGE':'should not appear','__REALTIME_TIMESTAMP':'1000000'},{'_SYSTEMD_UNIT':p.UNIT,'MESSAGE':'token=SECRET123 https://example.test/browser/1?signature=abc&expires=9','__REALTIME_TIMESTAMP':'1000000'}]
  def runner(args,**kwargs):
   self.assertIn(p.UNIT,args);self.assertNotIn('shell',kwargs);self.assertEqual(kwargs['timeout'],10)
   return subprocess.CompletedProcess(args,0,'\n'.join(json.dumps(i) for i in records),'')
  entries=p.read_logs('1h','',('SECRET123',),runner);self.assertEqual(len(entries),1);self.assertNotIn('SECRET123',entries[0]['message']);self.assertNotIn('signature=',entries[0]['message'])
  with self.assertRaises(ValueError):p.read_logs('1h; rm -rf /','',runner=runner)
  with self.assertRaises(ValueError):p.read_logs('1h','x'*201,runner=runner)
  self.assertNotIn('very-secret',p.redact('access_token: "very-secret"'))
unittest.main()
