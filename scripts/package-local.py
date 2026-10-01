#!/usr/bin/env python3
"""Create a secret-free local testing payload and matching audio source archive."""
import hashlib,pathlib,tarfile,sys
root=pathlib.Path(__file__).resolve().parent.parent
out=pathlib.Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
items=['dist','bin','node_modules','scripts','cook','licenses','LICENSE','README.md','docs','package.json','package-lock.json','.npmrc','.env.example']
for item in items:
    if not (root/item).exists():raise RuntimeError('Missing payload component: '+item)
def safe(info):
    parts=pathlib.PurePosixPath(info.name).parts
    if any(part in {'.git','work','build-tmp-napi-v3'} for part in parts):return None
    if any(part=='.env' or (part.startswith('.env.') and part!='.env.example') for part in parts):return None
    return info
payload=out/'the-witness-linux-x64-node24.tar.gz'
with tarfile.open(payload,'w:gz') as archive:
    for item in items:archive.add(root/item,arcname='TheWitness/'+item,filter=safe)
sources=out/'the-witness-audio-sources.tar.gz'
with tarfile.open(sources,'w:gz') as archive:
    for item in ['scripts/build-portable-audio.sh','scripts/prepare-audio-sources.py','licenses/audio','cook']:
        archive.add(root/item,arcname='TheWitness/'+item)
    archive.add(root/'work/portable/sources',arcname='TheWitness/work/portable/sources')
(out/'SHA256SUMS').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name+'\n' for file in [payload,sources]))
print('Created local testing payload and matching audio sources in '+str(out))
