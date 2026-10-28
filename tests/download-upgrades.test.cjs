const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {writeAudacity}=require('../dist/exports/audacity');
const {downloadName}=require('../dist/downloads/names');
const {RecordingSession}=require('../dist/recording/session');
test('recording date, server and room determine ZIP names regardless of current date',()=>{
 const m={startedAt:'2026-10-27T17:00:00-04:00',guildName:'My Server',channelName:'General Voice'};
 assert.equal(downloadName('project.zip',m,'date'),'2026-10-27-My-Server-General-Voice.zip');
 assert.equal(downloadName('project.zip',m,'date-channel'),'2026-10-27-My-Server-General-Voice.zip');
 assert.equal(downloadName('project.zip',m,'original'),'project.zip');
 const tracks=[{file:'track-1.wav',username:'Alice'},{file:'track-2.wav',username:'Alice'}];
 assert.notEqual(downloadName(tracks[0].file,{...m,tracks},'date'),downloadName(tracks[1].file,{...m,tracks},'date'));
 assert.ok(!downloadName(tracks[0].file,{...m,tracks},'date').includes('track-1'));
});
test('server and room names are captured in source recording metadata',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-server-name-'));
 try{const s=await RecordingSession.create(root,'guild','voice','Room',8,'My Server');await s.close();const m=JSON.parse(await fs.readFile(path.join(s.directory,'session.json'),'utf8'));assert.equal(m.guildName,'My Server');assert.equal(m.channelName,'Room');assert.equal(m.startedAt,s.startedAt);}finally{await fs.rm(root,{recursive:true,force:true});}
});
