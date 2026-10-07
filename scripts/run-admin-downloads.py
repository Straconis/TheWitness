#!/usr/bin/env python3
"""Hold the application's deployment lock while running reviewed download setup."""
import fcntl, os, pathlib, stat, subprocess, sys

BASE=pathlib.Path('/usr/local/libexec/the-witness-admin')
LOCK=pathlib.Path('/opt/the-witness/.releases/deploy.lock')

def main():
    if os.geteuid()!=0:raise SystemExit('Run through sudo witness-admin.')
    actions={'downloads-domain':'enable-downloads-domain.sh','downloads-ip':'enable-downloads-ip.sh'}
    if len(sys.argv)!=2 or sys.argv[1] not in actions:raise SystemExit('Choose downloads-domain or downloads-ip.')
    # Read-only, nonblocking and no-follow: never truncate a deployment-controlled
    # path, follow a symlink, or hang opening a substituted FIFO as root.
    try:fd=os.open(LOCK,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError:raise SystemExit('Cannot open the deployment lock safely; no setup changes made.')
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise SystemExit('Invalid deployment lock; no setup changes made.')
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise SystemExit('A deployment or download setup is running; try again later.')
        result=subprocess.run(['/bin/bash','--noprofile','--norc',str(BASE/actions[sys.argv[1]])])
        if result.returncode:raise SystemExit(result.returncode)
    finally:os.close(fd)

if __name__=='__main__':main()
