#!/usr/bin/env python3
"""Configure Cloudflare visitor IPs only for the Witness log virtual host."""
import ipaddress, os, pathlib, shutil, subprocess, sys, tempfile
from datetime import datetime, timezone

def ranges():
    result=[]
    for version in (4,6):
        body=subprocess.run(['/usr/bin/curl','--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-time','15','--max-filesize','16384','https://www.cloudflare.com/ips-v'+str(version)],capture_output=True,check=True,timeout=20).stdout
        if len(body)>16384: raise ValueError('Cloudflare response too large')
        items=body.decode('ascii').splitlines()
        if not 2<=len(items)<=100: raise ValueError('Unexpected Cloudflare range count')
        for item in items:
            net=ipaddress.ip_network(item.strip(),strict=True)
            if net.version!=version or not net.network_address.is_global or net.prefixlen<(8 if version==4 else 19):
                raise ValueError('Invalid or overly broad Cloudflare range')
            result.append(str(net))
    return result

def main():
    if sys.argv[1:] not in ([],['--check']):raise SystemExit('Usage: configure-witness-log-real-ip.py [--check]')
    networks=ranges()
    snippet='# Cloudflare ranges retrieved '+datetime.now(timezone.utc).isoformat()+'\n'+''.join('set_real_ip_from '+net+';\n' for net in networks)+'real_ip_header CF-Connecting-IP;\nreal_ip_recursive on;\n'
    if sys.argv[1:]==['--check']:
        print('Validated',len(networks),'official Cloudflare CIDRs. No configuration changed.');return
    if os.geteuid()!=0:raise SystemExit('Run with sudo on the VPS.')
    site=pathlib.Path('/etc/nginx/sites-available/the-witness-logs')
    target=pathlib.Path('/etc/nginx/snippets/the-witness-cloudflare-real-ip.conf')
    text=site.read_text();marker=' server_name logs.thewitness.dev;'
    include=' include '+str(target)+';'
    if text.count(marker)!=2:raise SystemExit('Unexpected log virtual-host layout; no changes made.')
    updated=text if include in text else text.replace(marker,marker+'\n'+include)
    # Backup is private and persists after successful application.
    backup=pathlib.Path(tempfile.mkdtemp(prefix='the-witness-nginx-',dir='/var/backups'))
    shutil.copy2(site,backup/'site');old_snippet=target.exists()
    if old_snippet:shutil.copy2(target,backup/'snippet')
    def replace(path,body,mode):
        fd,name=tempfile.mkstemp(prefix=path.name+'.',dir=path.parent)
        try:
            with os.fdopen(fd,'w') as file:file.write(body)
            os.chmod(name,mode);os.replace(name,path)
        finally:
            if os.path.exists(name):os.unlink(name)
    try:
        target.parent.mkdir(parents=True,exist_ok=True)
        replace(target,snippet,0o644);replace(site,updated,0o644)
        subprocess.run(['/usr/sbin/nginx','-t'],check=True)
        subprocess.run(['/usr/bin/systemctl','reload','nginx'],check=True)
        subprocess.run(['/usr/bin/systemctl','is-active','--quiet','nginx'],check=True)
    except BaseException:
        shutil.copy2(backup/'site',site)
        if old_snippet:shutil.copy2(backup/'snippet',target)
        else:target.unlink(missing_ok=True)
        subprocess.run(['/usr/sbin/nginx','-t'],check=False)
        subprocess.run(['/usr/bin/systemctl','reload','nginx'],check=False)
        raise
    print('Log portal now trusts visitor-IP headers only from Cloudflare ranges.')
    print('Nginx reloaded; bot and portal passwords unchanged. Backup:',backup)

if __name__=='__main__':main()
