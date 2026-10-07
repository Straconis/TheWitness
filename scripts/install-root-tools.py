#!/usr/bin/env python3
"""Install an explicitly reviewed, checksum-pinned admin snapshot; never called by deploy."""
import os, pathlib, shutil, stat, tempfile
FILES=('run-admin-downloads.py','set-portal-username.py','enable-log-portal.sh','configure-witness-log-real-ip.py','enable-downloads-domain.sh','enable-downloads-ip.sh','enable-github-deploy.sh')
def secure(path):
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
        raise SystemExit('Unsafe administrator directory: '+str(path))
def main():
    if os.geteuid()!=0:raise SystemExit('Run from the verified root-only bundle using sudo.')
    source=pathlib.Path(__file__).resolve().parent
    secure(source)
    for ancestor in source.parents:
        if str(ancestor)=='/':break
        secure(ancestor)
    base=pathlib.Path('/usr/local/libexec/the-witness-admin')
    for path in [pathlib.Path('/usr'),pathlib.Path('/usr/local'),pathlib.Path('/usr/local/libexec'),pathlib.Path('/usr/local/sbin')]:
        path.mkdir(exist_ok=True);secure(path)
    base.mkdir(exist_ok=True,mode=0o755);secure(base)
    # Validate the entire reviewed bundle before writing any installed command.
    payloads={}
    for name in (*FILES,'witness-admin'):
        file=source/name;info=file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise SystemExit('Unsafe bundled file: '+name)
        payloads[name]=file.read_bytes()
    for name,body in payloads.items():
        target=pathlib.Path('/usr/local/sbin/witness-admin') if name=='witness-admin' else base/name
        fd,temporary=tempfile.mkstemp(prefix=target.name+'.',dir=target.parent)
        try:
            with os.fdopen(fd,'wb') as stream:stream.write(body)
            os.chown(temporary,0,0);os.chmod(temporary,0o755);os.replace(temporary,target)
        finally:
            if os.path.exists(temporary):os.unlink(temporary)
    print('Reviewed root-owned Witness admin tools installed. Deployments cannot replace them.')
    print('No service restarted; portal login and nginx configuration preserved.')
if __name__=='__main__':main()
