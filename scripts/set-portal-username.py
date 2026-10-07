#!/usr/bin/env python3
"""Root-owned portal username update; preserve the password hash and redactions."""
import os, pathlib, re, subprocess, sys, tempfile

def main():
    if os.geteuid()!=0:raise SystemExit('Run through sudo witness-admin portal-username NAME.')
    if len(sys.argv)!=2 or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',sys.argv[1]):raise SystemExit('Use a username with 1–64 letters, digits, underscores or hyphens.')
    config=pathlib.Path('/etc/the-witness-log-portal.env')
    if not config.is_file():raise SystemExit('Portal is not configured; run log-setup first.')
    previous=config.read_text();lines=previous.splitlines()
    if sum(line.startswith('LOG_PORTAL_USERNAME=') for line in lines)!=1:raise SystemExit('Invalid existing portal configuration.')
    body='\n'.join('LOG_PORTAL_USERNAME='+sys.argv[1] if line.startswith('LOG_PORTAL_USERNAME=') else line for line in lines)+'\n'
    def save(value):
        fd,name=tempfile.mkstemp(dir=config.parent,prefix=config.name+'.')
        try:
            with os.fdopen(fd,'w') as f:f.write(value)
            os.chmod(name,0o600);os.chown(name,0,0);os.replace(name,config)
        finally:
            if os.path.exists(name):os.unlink(name)
    try:
        save(body);subprocess.run(['/usr/bin/systemctl','restart','the-witness-log-portal.service'],check=True)
        import time
        time.sleep(2);subprocess.run(['/usr/bin/systemctl','is-active','--quiet','the-witness-log-portal.service'],check=True)
    except BaseException:
        save(previous);subprocess.run(['/usr/bin/systemctl','restart','the-witness-log-portal.service'],check=False);raise
    print('Portal username is now '+sys.argv[1]+'. Existing password preserved.')
if __name__=='__main__':main()
