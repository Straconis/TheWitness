#!/usr/bin/env python3
"""Build pinned CPU-only whisper.cpp and fetch a checksum-verified English model without sudo."""
import pathlib,json,hashlib,urllib.request,tarfile,subprocess,shutil
root=pathlib.Path(__file__).resolve().parent.parent
spec=json.loads((root/'licenses/transcription/sources.json').read_text());work=root/'work/transcription';work.mkdir(parents=True,exist_ok=True)
source=work/'whisper.cpp'
if not source.exists():subprocess.run(['git','clone','--no-checkout',spec['engine']['repository'],str(source)],check=True)
subprocess.run(['git','-C',str(source),'checkout','--detach',spec['engine']['commit']],check=True)
cmakeArchive=work/'cmake.tar.gz'
def fetch(url,target,digest):
    if not target.exists():urllib.request.urlretrieve(url,target)
    if hashlib.sha256(target.read_bytes()).hexdigest()!=digest:raise RuntimeError('Checksum mismatch: '+target.name)
fetch(spec['buildTool']['url'],cmakeArchive,spec['buildTool']['sha256'])
with tarfile.open(cmakeArchive) as archive:archive.extractall(work,filter='data')
cmake=next(work.glob('cmake-*/bin/cmake'));build=work/'build'
subprocess.run([str(cmake),'-S',str(source),'-B',str(build),'-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF','-DGGML_NATIVE=OFF','-DGGML_OPENMP=OFF','-DWHISPER_BUILD_TESTS=OFF','-DWHISPER_BUILD_SERVER=OFF','-DCMAKE_EXE_LINKER_FLAGS=-static'],check=True)
subprocess.run([str(cmake),'--build',str(build),'--target','whisper-cli','-j2'],check=True)
(root/'bin/models').mkdir(parents=True,exist_ok=True);shutil.copy2(build/'bin/whisper-cli',root/'bin/whisper-cli')
fetch(spec['model']['url'],root/'bin/models'/spec['model']['name'],spec['model']['sha256'])
subprocess.run(['git','-C',str(source),'archive','--format=tar.gz','--prefix=whisper.cpp-v1.8.7/','-o',str(work/'whisper.cpp-v1.8.7.tar.gz'),'HEAD'],check=True)
print('Bundled transcription engine and model ready. Transcription remains opt-in.')
