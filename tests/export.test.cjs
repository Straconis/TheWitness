const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, readdir } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { OpusEncoder } = require('@discordjs/opus');
const { RecordingSession } = require('../dist/recording/session');
const { exportSession } = require('../dist/exports/export');

function packets(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(bytes.toString('ascii',offset,offset+4), 'OggS');
    const segments = bytes[offset+26];
    const size = [...bytes.subarray(offset+27,offset+27+segments)].reduce((a,b)=>a+b,0);
    result.push({ data: bytes.subarray(offset+27+segments,offset+27+segments+size), time: bytes.readBigUInt64LE(offset+6) });
    offset += 27+segments+size;
  }
  return result;
}

test('Craig correction exports separate tracks that decode to PCM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'witness-export-'));
  try {
    const session = await RecordingSession.create(root,'guild','voice');
    const encoder = new OpusEncoder(48000,2);
    const pcm = Buffer.alloc(960*2*2);
    for (let frame = 0; frame < 20; frame++) {
      for (let i=0;i<960;i++) {
        const value = Math.round(Math.sin((frame*960+i)*2*Math.PI*440/48000)*8000);
        pcm.writeInt16LE(value,i*4); pcm.writeInt16LE(value,i*4+2);
      }
      const opus = encoder.encode(pcm);
      await session.append(opus,'alice','Alice',frame*960);
      await session.append(opus,'bob','Bob',frame*960);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await assert.rejects(exportSession(root,session.id), /completed/);
    await session.close();
    const output = await exportSession(root,session.id);
    const manifest = JSON.parse(await readFile(path.join(output,'manifest.json')));
    assert.deepEqual(manifest.tracks.map(t=>t.userID),['alice','bob']);
    for (const track of manifest.tracks) {
      const pages = packets(await readFile(path.join(output,track.file)));
      assert.equal(pages[0].data.toString('ascii',0,8),'OpusHead');
      assert.equal(pages[1].data.toString('ascii',0,8),'OpusTags');
      const decoder = new OpusEncoder(48000,2);
      const audio = pages.slice(2).filter(p=>p.data.length>0);
      assert.ok(audio.length >= 20);
      assert.ok(audio.some(p=>decoder.decode(p.data).some(byte=>byte!==0)));
      assert.ok(audio.every((p,i)=>i===0 || p.time>=audio[i-1].time));
    }
    const ffmpeg = process.env.FFMPEG_PATH || (require('node:fs').existsSync(path.resolve(__dirname, '../bin/ffmpeg')) ? path.resolve(__dirname, '../bin/ffmpeg') : 'ffmpeg');
    const { spawnSync } = require('node:child_process');
    const available = spawnSync(ffmpeg, ['-version']);
    if (available.status === 0) {
      for (const format of ['wav','flac','mp3']) {
        const directory = await exportSession(root,session.id,{format,ffmpegPath:ffmpeg});
        const manifest = JSON.parse(await readFile(path.join(directory,'manifest.json')));
        assert.equal(manifest.tracks.length,2);
        for (const track of manifest.tracks) {
          const decoded = spawnSync(ffmpeg,['-v','error','-i',path.join(directory,track.file),'-f','s16le','-'],{maxBuffer:1024*1024});
          assert.equal(decoded.status,0,decoded.stderr?.toString());
          assert.ok(decoded.stdout.length >= (20*960-3840-960)*2*2);
          assert.ok(decoded.stdout.some(byte=>byte!==0));
        }
      }
    } else {
      console.log('FFmpeg conversion checks unavailable; Ogg correction remains tested.');
    }
    await assert.rejects(exportSession(root,'../../elsewhere'), /Invalid session/);
    await assert.rejects(exportSession(root,session.id,{correctorPath:'/missing/oggcorrect'}));
    await assert.rejects(exportSession(root,session.id,{format:'wav',ffmpegPath:'/missing/ffmpeg'}));
    assert.ok((await readdir(session.directory)).every(name=>!name.endsWith('.tmp')));
  } finally { await rm(root,{recursive:true,force:true}); }
});
