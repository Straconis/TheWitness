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
    response=request('/api/logs?window=6h&q=session','operator:correct-password');self.assertEqual(response.status,200);reader.assert_called_with('6h','session',())
    self.assertEqual(request('/api/logs?unit=ssh.service','operator:correct-password').status,400)
    self.assertEqual(request('/api/logs','operator:correct-password','POST').status,405)
    self.assertEqual(request('/api/download','operator:correct-password').status,200)
   with patch.object(p,'read_logs',side_effect=subprocess.CalledProcessError(1,['journalctl'],stderr='secret')):
    response=request('/api/logs','operator:correct-password');self.assertEqual(response.status,503);self.assertNotIn(b'secret',response.read())
   self.assertNotIn('innerHTML',p.JS)
  finally:server.shutdown();server.server_close();thread.join()
 def test_installer_username_prompt_on_a_real_terminal(self):
  import os, pty, fcntl, termios
  installer=(pathlib.Path(__file__).parents[1]/'scripts/enable-log-portal.sh').read_text()
  start=installer.index("with open('/dev/tty','w')")
  fragment=installer[start:installer.index('if not username.isascii()',start)]
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
