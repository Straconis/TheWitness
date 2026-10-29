#!/usr/bin/env python3
"""Fetch checksum-pinned upstream sources used by build-portable-audio.sh."""
import hashlib,http.client,json,pathlib,tarfile,time,urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
sources=root/'work/portable/sources';build=root/'work/portable/build'
sources.mkdir(parents=True,exist_ok=True);build.mkdir(parents=True,exist_ok=True)
manifest=json.loads((root/'licenses/audio/sources.json').read_text())
for name,info in manifest.items():
    target=sources/name
    if not target.exists():
        for attempt in range(1,5):
            try:
                print(f'Downloading {name} (attempt {attempt}/4)',flush=True)
                with urllib.request.urlopen(info['url'],timeout=30) as response:payload=response.read()
                target.write_bytes(payload)
                break
            except (OSError,http.client.HTTPException) as error:
                if attempt==4:raise
                print(f'Download failed for {name}: {error}; retrying.',flush=True)
                time.sleep(attempt*2)
    if hashlib.sha256(target.read_bytes()).hexdigest()!=info['sha256']:raise RuntimeError('Source checksum mismatch: '+name)
    if name.endswith(('.tar.xz','.tar.gz')):
        with tarfile.open(target) as archive:archive.extractall(build,filter='data')
print('Pinned audio sources verified and extracted.')
