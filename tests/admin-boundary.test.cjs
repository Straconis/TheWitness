const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),path=require('node:path');
test('administrator installer refuses a writable snapshot before touching privileged files',()=>{
 const code=`import importlib.util, pathlib, tempfile, os
spec=importlib.util.spec_from_file_location('installer',${JSON.stringify(path.resolve('scripts/install-root-tools.py'))});m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root)/'unsafe';p.mkdir();p.chmod(0o777);m.__file__=str(p/'install-root-tools.py');m.os.geteuid=lambda:0
 try:m.main()
 except SystemExit as e:
  assert 'Unsafe administrator directory' in str(e),e
  print('Unsafe snapshot rejected before installation')
 else:raise AssertionError('Writable administrator snapshot accepted')`;
 const r=spawnSync('python3',['-I','-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/rejected/);
});
test('isolated Python ignores module shadowing from the deployment working directory',()=>{
 const r=spawnSync('python3',['-I','-c','import sys;assert "" not in sys.path;assert not any(p.endswith("/TheWitness") for p in sys.path);print("isolated")'],{encoding:'utf8',env:{...process.env,PYTHONPATH:process.cwd()}});assert.equal(r.status,0,r.stderr);
});
test('portal username changes preserve private fields and roll back on restart failure',()=>{
 const code=`import pathlib,tempfile,sys,subprocess,types,os,time
source=pathlib.Path(${JSON.stringify(path.resolve('scripts/set-portal-username.py'))}).read_text()
with tempfile.TemporaryDirectory() as root:
 file=pathlib.Path(root)/'portal.env';original='LOG_PORTAL_USERNAME=old\\nLOG_PORTAL_PASSWORD_HASH=scrypt$fixture$unchanged\\nLOG_PORTAL_REDACT_VALUES="[]"\\n';file.write_text(original)
 source=source.replace('/etc/the-witness-log-portal.env',str(file));module=types.ModuleType('fixture');exec(compile(source,'fixture','exec'),module.__dict__)
 module.os.geteuid=lambda:0;module.os.chown=lambda *a:None;module.subprocess.run=lambda *a,**k:None;time.sleep=lambda *a:None
 sys.argv=['fixture','watcher'];module.main();updated=file.read_text();assert updated==original.replace('USERNAME=old','USERNAME=watcher');assert file.stat().st_mode&0o777==0o600
 calls=0
 def failed(*a,**k):
  global calls
  calls+=1
  if calls==1:raise subprocess.CalledProcessError(1,['systemctl'])
 module.subprocess.run=failed;sys.argv=['fixture','different']
 try:module.main()
 except subprocess.CalledProcessError:pass
 else:raise AssertionError('Expected restart failure')
 assert file.read_text()==updated
 print('Private fields preserved and failed restart rolled back')`;
 const r=spawnSync('python3',['-I','-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/rolled back/);
});
test('account migration preserves operator keys and rolls back a failed service start',()=>{
 const code=`import pathlib,tempfile,types,os,subprocess,time
source=pathlib.Path(${JSON.stringify(path.resolve('scripts/migrate-deploy-account.py'))}).read_text()
time.sleep=lambda *a:None
for fail in (False,True):
 with tempfile.TemporaryDirectory() as root:
  root=pathlib.Path(root);app=root/'app';(app/'.releases').mkdir(parents=True);(app/'.releases/deploy.lock').touch();(app/'payload').write_text('data')
  oldhome=root/'operator';(oldhome/'.ssh').mkdir(parents=True);auth=oldhome/'.ssh/authorized_keys';original='ssh-ed25519 AAAA operator\\nrestrict,command="/opt/the-witness/scripts/deploy-github.sh" ssh-ed25519 BBBB deploy\\n';auth.write_text(original)
  data=root/'external-recordings';data.mkdir();(data/'.deploy-pending').write_text('pending');(data/'private.json').write_text('fixture');
  unit=root/'bot.service';original_unit='[Service]\\nUser=straconis\\nGroup=straconis\\nNoNewPrivileges=true\\n';unit.write_text(original_unit)
  policy=root/'sudoers';policy.mkdir();(policy/'the-witness-github-deploy').write_text('previous policy');(root/'backups').mkdir();home=root/'deploy'
  code=source.replace('/var/lib/the-witness-deploy',str(home)).replace('/etc/sudoers.d',str(policy)).replace('/var/backups',str(root/'backups'))
  m=types.ModuleType('fixture');exec(compile(code,'fixture','exec'),m.__dict__);m.APP=app;m.DATA=data;m.UNIT=unit;m.os.geteuid=lambda:0;m.os.chown=lambda *a,**k:None
  def account(user):return types.SimpleNamespace(pw_dir=str(oldhome if user=='straconis' else home),pw_uid=1000 if user=='straconis' else 999,pw_gid=1000 if user=='straconis' else 999)
  m.pwd.getpwnam=account;starts=0
  copy=m.shutil.copy2
  def rootcopy(src,dst,*a,_copy=copy,**k):
   dst=pathlib.Path(dst)
   if dst.exists():dst.chmod(0o600) # emulate root bypassing fixture DAC permissions
   return _copy(src,dst,*a,**k)
  m.shutil.copy2=rootcopy
  def run(args,**kwargs):
   global starts
   if args[:2]==('/usr/bin/systemctl','start'):
    starts+=1
    if fail and starts==1:raise subprocess.CalledProcessError(1,args)
   return types.SimpleNamespace(returncode=0)
  m.subprocess.run=run
  try:m.main()
  except subprocess.CalledProcessError:
   assert fail;assert unit.read_text()==original_unit;assert auth.read_text()==original;assert (policy/'the-witness-github-deploy').read_text()=='previous policy';assert not (home/'.ssh/authorized_keys').exists()
  else:
   assert not fail;assert 'User=witness-deploy' in unit.read_text();assert 'NoNewPrivileges=true' in unit.read_text();assert auth.read_text()=='ssh-ed25519 AAAA operator\\n';assert 'BBBB' in (home/'.ssh/authorized_keys').read_text();assert 'NOPASSWD' in (policy/'the-witness-github-deploy').read_text();snapshots=list((root/'backups').glob('*/ownership.json'));assert snapshots;assert str(data/'private.json') in snapshots[0].read_text();assert str(data/'.deploy-pending') in snapshots[0].read_text()
print('Migration isolation and rollback verified')`;
 const r=spawnSync('python3',['-I','-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/rollback verified/);
});
test('download administration shares the deployment lock and rejects unsafe lock files',()=>{
 const code=`import importlib.util,pathlib,tempfile,os,sys,fcntl,subprocess
spec=importlib.util.spec_from_file_location('admin',${JSON.stringify(path.resolve('scripts/run-admin-downloads.py'))});m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.os.geteuid=lambda:0;sys.argv=['fixture','downloads-domain']
with tempfile.TemporaryDirectory() as root:
 root=pathlib.Path(root);m.LOCK=root/'lock';m.LOCK.write_text('unchanged');m.BASE=root
 held=os.open(m.LOCK,os.O_RDONLY);fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def forbidden(*a,**k):raise AssertionError('Setup ran while deployment held its lock')
 m.subprocess.run=forbidden
 try:m.main()
 except SystemExit as e:assert 'running' in str(e),e
 else:raise AssertionError('Concurrent setup accepted')
 os.close(held)
 calls=[]
 def setup(args):
  other=os.open(m.LOCK,os.O_RDONLY)
  try:
   try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:pass
   else:raise AssertionError('Setup did not retain deployment lock')
  finally:os.close(other)
  calls.append(args);return subprocess.CompletedProcess(args,0)
 m.subprocess.run=setup;m.main();assert calls==[['/bin/bash','--noprofile','--norc',str(root/'enable-downloads-domain.sh')]];assert m.LOCK.read_text()=='unchanged'
 m.subprocess.run=forbidden;m.LOCK.unlink();target=root/'target';target.write_text('preserved');m.LOCK.symlink_to(target)
 try:m.main()
 except SystemExit as e:assert 'safely' in str(e),e
 else:raise AssertionError('Symlink lock accepted')
 assert target.read_text()=='preserved';m.LOCK.unlink();os.mkfifo(m.LOCK)
 try:m.main()
 except SystemExit as e:assert 'Invalid deployment lock' in str(e),e
 else:raise AssertionError('FIFO lock accepted')
 print('Shared lock excludes concurrent setup; unsafe paths rejected')`;
 const r=spawnSync('python3',['-I','-c',code],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/unsafe paths rejected/);
});
