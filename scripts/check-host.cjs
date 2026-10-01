const {spawnSync}=require('node:child_process');const {existsSync,chmodSync}=require('node:fs');const path=require('node:path');
let failures=0;function check(name,fn){try{fn();console.log(`OK: ${name}`);}catch(error){failures++;console.error(`FAIL: ${name}: ${error.message}`);}}
check('Node runtime',()=>{if(Number(process.versions.node.split('.')[0])!==24)throw Error('This payload is tested with Node 24. Select Node 24 on the host.');});
check('Linux architecture',()=>{if(process.platform!=='linux'||process.arch!=='x64')throw Error('Bundled audio tools require Linux x86_64.');});
check('Native Opus encoder',()=>{const {OpusEncoder}=require('@discordjs/opus');new OpusEncoder(48000,2).encode(Buffer.alloc(3840));});
check('Discord encryption module',()=>{require('@snazzah/davey');});
check('Compiled application',()=>{if(!existsSync(path.resolve(__dirname,'../dist/index.js')))throw Error('Run the build before packaging.');});
for(const name of ['ffmpeg','oggcorrect'])check(name,()=>{const file=path.resolve(__dirname,'../bin',name);chmodSync(file,0o755);const result=spawnSync(file,name==='ffmpeg'?['-version']:[],{input:Buffer.alloc(0),timeout:10000});if(result.error)throw result.error;if(name==='ffmpeg'&&result.status!==0)throw Error(result.stderr.toString());});
check('Transcription engine and model',()=>{const {transcriptionConfig,transcriptionReady}=require('../dist/integrations/transcription-config');if(!transcriptionReady())throw Error('Bundle whisper-cli and its model or configure their paths.');const result=spawnSync(transcriptionConfig().executable,['--version'],{timeout:10000});if(result.error||result.status!==0)throw result.error||Error('Speech engine did not start.');});
if(failures)process.exitCode=1;else console.log('Offline host checks passed. Discord credentials and public web routing still need live tests.');
