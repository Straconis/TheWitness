#!/usr/bin/env python3
"""Explicit root-only migration, executed from a reviewed pinned bundle."""
import fcntl, json, os, pathlib, pwd, re, shutil, stat, subprocess, tempfile
APP=pathlib.Path('/opt/the-witness')
UNIT=pathlib.Path('/etc/systemd/system/the-witness.service')
OLD='straconis'
NEW='witness-deploy'
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def appcheck(user,action=None):
    args=['/usr/sbin/runuser','-u',user,'--','/usr/local/bin/node','scripts/deploy-idle.cjs']
    if action:args.append(action)
    run(*args,cwd=APP,timeout=30)
def atomic(path,body,mode=0o644):
    fd,name=tempfile.mkstemp(dir=path.parent,prefix=path.name+'.')
    try:
        with os.fdopen(fd,'w') as f:f.write(body)
        os.chmod(name,mode);os.chown(name,0,0);os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
def main():
    if os.geteuid()!=0:raise SystemExit('Run the reviewed migration bundle with sudo.')
    old=pwd.getpwnam(OLD)
    auth=pathlib.Path(old.pw_dir)/'.ssh/authorized_keys'
    original=auth.read_text()
    lines=original.splitlines()
    deploy=[line for line in lines if 'command="/opt/the-witness/scripts/deploy-github.sh"' in line]
    if not deploy:
        if 'User='+NEW in UNIT.read_text():
            print('Dedicated deployment account is already configured.');return
        raise SystemExit('Expected exactly one existing GitHub forced-command key; no changes made.')
    if len(deploy)!=1:raise SystemExit('Ambiguous deployment keys; no changes made.')
    key=re.search(r'\b(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+([A-Za-z0-9+/=]+)(?:\s.*)?$',deploy[0])
    if not key:raise SystemExit('Cannot identify the existing GitHub public key.')
    remaining=[line for line in lines if line!=deploy[0]]
    if not any(line.strip() and not line.lstrip().startswith('#') for line in remaining):
        raise SystemExit('Refusing to remove the only administrator SSH key.')
    body=UNIT.read_text()
    if body.count('User='+OLD)!=1 or body.count('Group='+OLD)!=1:raise SystemExit('Unexpected bot service identity.')
    # Do not truncate or follow a potentially deployment-controlled lock symlink.
    lock=os.open(APP/'.releases/deploy.lock',os.O_RDWR|os.O_NOFOLLOW)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    backup=pathlib.Path(tempfile.mkdtemp(prefix='the-witness-account-',dir='/var/backups'))
    shutil.copy2(UNIT,backup/'bot.service');shutil.copy2(auth,backup/'admin-authorized_keys')
    policies=[pathlib.Path('/etc/sudoers.d')/name for name in ['the-witness-github-deploy','the-witness-log-portal']]
    for policy in policies:
        if policy.exists():shutil.copy2(policy,backup/policy.name)
    marker=False;stopped=False;owners=[];new_key=None
    was_active=subprocess.run(['/usr/bin/systemctl','is-active','--quiet','the-witness.service']).returncode==0
    try:
        appcheck(OLD,'prepare');marker=True
        appcheck(OLD) # Busy means stop here, preserve live work, clear marker below.
        try:new=pwd.getpwnam(NEW)
        except KeyError:
            run('/usr/sbin/useradd','--system','--home-dir','/var/lib/the-witness-deploy','--shell','/bin/bash',NEW)
            new=pwd.getpwnam(NEW)
        if new.pw_uid==0:raise RuntimeError('Invalid deployment UID')
        home=pathlib.Path(new.pw_dir)
        if str(home)!='/var/lib/the-witness-deploy':raise RuntimeError('Unexpected deployment home')
        if home.is_symlink():raise RuntimeError('Unsafe deployment home')
        home.mkdir(exist_ok=True);os.chown(home,0,0);os.chmod(home,0o755)
        ssh=home/'.ssh'
        if ssh.is_symlink():raise RuntimeError('Unsafe deployment SSH directory')
        ssh.mkdir(exist_ok=True);os.chown(ssh,0,0);os.chmod(ssh,0o755)
        if ssh.is_symlink() or home.is_symlink():raise RuntimeError('Unsafe deployment home')
        new_key=ssh/'authorized_keys'
        atomic(new_key,'restrict,command="/opt/the-witness/scripts/deploy-github.sh" '+key[1]+' '+key[2]+'\n')
        rule=backup/'new-sudoers'
        rule.write_text(NEW+' ALL=(root) NOPASSWD: /usr/bin/systemctl restart the-witness.service, /usr/bin/systemctl restart the-witness-log-portal.service\n')
        run('/usr/sbin/visudo','-cf',str(rule))
        run('/usr/bin/systemctl','stop','the-witness.service');stopped=True
        for directory,dirs,files in os.walk(APP,followlinks=False):
            for path in [pathlib.Path(directory),*(pathlib.Path(directory)/name for name in dirs+files)]:
                info=path.lstat();owners.append((str(path),info.st_uid,info.st_gid));os.chown(path,new.pw_uid,new.pw_gid,follow_symlinks=False)
        (backup/'ownership.json').write_text(json.dumps(owners))
        atomic(UNIT,body.replace('User='+OLD,'User='+NEW).replace('Group='+OLD,'Group='+NEW))
        atomic(policies[0],rule.read_text(),0o440)
        policies[1].unlink(missing_ok=True)
        # Keep operator keys and remove the old GitHub account entry.
        atomic(auth,'\n'.join(remaining)+'\n',0o600);os.chown(auth,old.pw_uid,old.pw_gid)
        run('/usr/bin/systemctl','daemon-reload')
        appcheck(NEW,'clear');marker=False
        if was_active:
            run('/usr/bin/systemctl','start','the-witness.service')
            import time
            time.sleep(3);run('/usr/bin/systemctl','is-active','--quiet','the-witness.service')
        print('Dedicated witness-deploy account configured; administrator SSH keys preserved.')
        print('GitHub must now deploy as witness-deploy. Root tools remain administrator-controlled.')
        print('Private rollback snapshot:',backup)
    except BaseException:
        if new_key is not None:new_key.unlink(missing_ok=True)
        shutil.copy2(backup/'bot.service',UNIT)
        shutil.copy2(backup/'admin-authorized_keys',auth)
        for policy in policies:
            previous=backup/policy.name
            if previous.exists():shutil.copy2(previous,policy)
            else:policy.unlink(missing_ok=True)
        for path,uid,gid in reversed(owners):
            if os.path.lexists(path):os.chown(path,uid,gid,follow_symlinks=False)
        run('/usr/bin/systemctl','daemon-reload')
        if stopped and was_active:run('/usr/bin/systemctl','start','the-witness.service')
        raise
    finally:
        if marker:
            try:appcheck(OLD,'clear')
            except Exception:pass
        os.close(lock)
if __name__=='__main__':main()
