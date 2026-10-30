// Local experiment only: does not change the production export pipeline.
// npm run build, then run in a systemd user scope with:
// MemoryMax=2G MemorySwapMax=0 CPUQuota=200%.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { runTool } = require('../dist/exports/process');
const { cleanSpeech, SPEECH_CLEANUP_FILTER, defaultAudioTool } = require('../dist/exports/speech-cleanup');
const { measureLevel } = require('../dist/exports/normalization');

function option(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const seconds = Number(option('seconds', 60));
const rounds = Number(option('rounds', 3));
assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 180, 'seconds: 10–180');
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 7, 'rounds: 1–7');
const root = path.resolve(__dirname, '..');
const out = path.resolve(option('out', path.join(root, 'work', 'cleanup-fusion', String(Date.now()))));
const media = path.join(out, 'media');
const tool = defaultAudioTool();
const cgroup = '/sys/fs/cgroup' + fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::')).slice(3);
const readGroup = name => fs.readFileSync(path.join(cgroup, name), 'utf8').trim();
const cpuSeconds = () => Number(/^usage_usec (\d+)$/m.exec(readGroup('cpu.stat'))[1]) / 1e6;
const memoryMax = Number(readGroup('memory.max'));
const [cpuQuota, cpuPeriod] = readGroup('cpu.max').split(' ').map(Number);
assert.ok(Number.isFinite(memoryMax) && memoryMax <= 2 * 1024 ** 3, 'Run with MemoryMax=2G');
assert.equal(readGroup('memory.swap.max'), '0', 'Run with MemorySwapMax=0');
assert.ok(Number.isFinite(cpuQuota) && cpuQuota / cpuPeriod <= 2, 'Run with CPUQuota=200%');

const modes = [
  { name: 'wav', codec: 'pcm_s16le', ext: 'wav', raw: false, precision: 's16' },
  { name: 'flac', codec: 'flac', ext: 'flac', raw: false, precision: 's32' },
  { name: 'flac-with-original', codec: 'flac', ext: 'flac', raw: true, precision: 's32' },
];
const report = {
  seconds, rounds, generatedFrames: seconds * 48000 + 137,
  limits: { memoryMax, swapMax: readGroup('memory.swap.max'), cpuMax: readGroup('cpu.max') },
  audioTool: execFileSync(tool, ['-version'], { encoding: 'utf8' }).split('\n').slice(0, 3),
  scope: 'Corrected-Opus decoding, lossless conversion and speech cleanup only; synthetic audio; no live/VPS recording touched.',
  caveats: ['CPU quota does not reproduce VPS processor speed.', '5 ms disk sampling can miss short-lived peaks.', 'FLAC uses a 32-bit sample container with 24-bit precision; format matching alone omits the encoder truncation. Strict PCM checks flag any difference.'],
  runs: [], quality: [],
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function save() {
  await fsp.writeFile(path.join(out, 'results.json.tmp'), JSON.stringify(report, null, 2) + '\n');
  await fsp.rename(path.join(out, 'results.json.tmp'), path.join(out, 'results.json'));
}
function diskBytes(directory) {
  let total = 0;
  const inodes = new Set();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        let stat;
        try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const key = stat.dev + ':' + stat.ino;
        if (!inodes.has(key)) { inodes.add(key); total += stat.blocks * 512; }
      }
    }
  }
  visit(directory);
  return total;
}
async function generateFixture(file) {
  const frames = report.generatedFrames, header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + frames * 4, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(frames * 4, 40);
  const handle = await fsp.open(file, 'wx');
  let seed = 42, phase = 0;
  try {
    await handle.write(header);
    for (let start = 0; start < frames; start += 48000) {
      const count = Math.min(48000, frames - start), chunk = Buffer.alloc(count * 4);
      for (let n = 0; n < count; n++) {
        const frame = start + n, t = frame / 48000;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        phase += 2 * Math.PI * (140 + 30 * Math.sin(t * 1.7)) / 48000;
        const active = t % 9 < 6 && frame < frames - 12000;
        const envelope = active ? (0.25 + 0.75 * Math.sin(t * Math.PI * 4.3) ** 2) : 0;
        const voice = 5000 * envelope * (Math.sin(phase) + .3 * Math.sin(phase * 2) + .15 * Math.sin(phase * 3));
        const background = frame < frames - 12000 ? 700 * Math.sin(t * 2 * Math.PI * 35) + (seed / 2 ** 32 - .5) * 250 : 0;
        let left = Math.round(voice + background), right = Math.round(voice * .8 + background * .7);
        if (frame === Math.floor(2.137 * 48000) || frame === frames - 200) left = 24000;
        if (frame === Math.floor(2.137 * 48000) + 19 || frame === frames - 169) right = -22000;
        chunk.writeInt16LE(left, n * 4); chunk.writeInt16LE(right, n * 4 + 2);
      }
      await handle.write(chunk);
    }
  } finally { await handle.close(); }
}
async function convert(args) { await runTool(tool, ['-nostdin', '-v', 'error', '-n', ...args]); }
const encoding = mode => ['-ar', '48000', '-c:a', mode.codec, ...(mode.ext === 'wav' ? ['-rf64', 'auto'] : [])];
async function execute(mode, flow, source, directory, round) {
  await fsp.mkdir(directory);
  const track = path.join(directory, 'track.' + mode.ext), raw = path.join(directory, 'raw.flac');
  const initialDisk = diskBytes(directory);
  let peakDisk = initialDisk;
  const timer = setInterval(() => { peakDisk = Math.max(peakDisk, diskBytes(directory)); }, 5);
  const cpu = cpuSeconds(), began = performance.now();
  try {
    if (flow === 'baseline') {
      if (mode.raw) {
        await convert(['-i', source, '-c:a', 'flac', raw]);
        await fsp.link(raw, track); // Matches production's untrimmed raw-FLAC hard-link path.
      } else await convert(['-i', source, ...encoding(mode), track]);
      await cleanSpeech(track, mode.codec, tool);
    } else {
      // Preserve the initial lossless conversion's sample-format rounding before
      // cleanup. FLAC's extra 24-bit truncation is not reproduced here;
      // its strict PCM comparison remains a required acceptance check.
      const filter = `aformat=sample_fmts=${mode.precision},${SPEECH_CLEANUP_FILTER}`;
      if (mode.raw) {
        await convert(['-i', source, '-filter_complex', `[0:a]asplit=2[original][voice];[voice]${filter}[clean]`,
          '-map', '[original]', '-c:a', 'flac', raw, '-map', '[clean]', ...encoding(mode), track]);
      } else await convert(['-i', source, '-af', filter, ...encoding(mode), track]);
    }
  } finally { clearInterval(timer); }
  const elapsedSeconds = (performance.now() - began) / 1000, usedCPU = cpuSeconds() - cpu;
  peakDisk = Math.max(peakDisk, diskBytes(directory));
  const trackSHA256 = hash(await fsp.readFile(track)), rawSHA256 = mode.raw ? hash(await fsp.readFile(raw)) : null;
  const earlier = report.runs.find(row => row.mode === mode.name && row.flow === flow);
  if (earlier) { assert.equal(trackSHA256, earlier.trackSHA256, "Repeated output is deterministic"); assert.equal(rawSHA256, earlier.rawSHA256); }
  const row = { mode: mode.name, flow, round, elapsedSeconds, cpuSeconds: usedCPU, trackSHA256, rawSHA256,
    peakAllocatedDiskBytes: peakDisk, finalAllocatedDiskBytes: diskBytes(directory),
    trackBytes: (await fsp.stat(track)).size, rawBytes: mode.raw ? (await fsp.stat(raw)).size : 0 };
  report.runs.push(row); await save(); console.log(JSON.stringify(row));
  return { track, raw };
}
function decode(file) {
  return execFileSync(tool, ['-nostdin', '-v', 'error', '-i', file, '-c:a', 'pcm_f32le', '-f', 'f32le', '-'], { maxBuffer: 160 * 1024 ** 2 });
}
function peakFrame(bytes, center, channel) {
  let index = Math.max(0, center - 1000), peak = -1;
  for (let frame = index; frame < Math.min(bytes.length / 8, center + 1000); frame++) {
    const value = Math.abs(bytes.readFloatLE(frame * 8 + channel * 4));
    if (value > peak) { index = frame; peak = value; }
  }
  return index;
}
async function compare(mode, outputs) {
  const original = decode(outputs.baseline.track), fused = decode(outputs.fused.track);
  assert.equal(original.length, fused.length, 'Identical frame count');
  assert.equal(original.length / 8, report.generatedFrames, 'Complete source duration, including tail');
  let squaredError = 0, squaredSignal = 0, maxDifference = 0;
  for (let i = 0; i < original.length; i += 4) {
    const a = original.readFloatLE(i), b = fused.readFloatLE(i), error = b - a;
    assert.ok(Number.isFinite(a) && Number.isFinite(b));
    squaredError += error * error; squaredSignal += a * a; maxDifference = Math.max(maxDifference, Math.abs(error));
  }
  const rmsError = Math.sqrt(squaredError / (original.length / 4));
  const markerOffsets = [];
  for (const frame of [Math.floor(2.137 * 48000), report.generatedFrames - 200]) for (const channel of [0, 1])
    markerOffsets.push(peakFrame(fused, frame, channel) - peakFrame(original, frame, channel));
  const baselineLevel = await measureLevel(outputs.baseline.track, tool), fusedLevel = await measureLevel(outputs.fused.track, tool);
  const rawIdentical = mode.raw ? (await fsp.readFile(outputs.baseline.raw)).equals(await fsp.readFile(outputs.fused.raw)) : null;
  const row = { mode: mode.name, frames: original.length / 8, pcmIdentical: original.equals(fused), encodedFileByteIdentical: (await fsp.readFile(outputs.baseline.track)).equals(await fsp.readFile(outputs.fused.track)), maxSampleDifference: maxDifference,
    rmsError, errorDBFS: rmsError ? 20 * Math.log10(rmsError) : null,
    signalToErrorDB: squaredError ? 10 * Math.log10(squaredSignal / squaredError) : null,
    markerOffsets, baselineLevel, fusedLevel, rawFileByteIdentical: rawIdentical };
  row.qualityChecksPassed = markerOffsets.every(offset => offset === 0) &&
    Math.abs(baselineLevel.lufs - fusedLevel.lufs) <= .05 && Math.abs(baselineLevel.truePeak - fusedLevel.truePeak) <= .05 &&
    row.pcmIdentical && (!mode.raw || rawIdentical);
  report.quality.push(row); await save(); console.log(JSON.stringify(row));
}
const median = numbers => { const sorted = [...numbers].sort((a,b) => a-b), middle = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2; };
(async () => {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.mkdir(out, { recursive: false });
  await fsp.mkdir(media);
  try {
    const disk = await fsp.statfs(out);
    assert.ok(disk.bavail * disk.bsize > 1024 ** 3 + report.generatedFrames * 4 * 5, 'Preserve 1 GiB free local disk');
    const wav = path.join(media, 'fixture.wav'), source = path.join(media, 'corrected.ogg');
    await generateFixture(wav);
    await convert(['-i', wav, '-c:a', 'libopus', '-b:a', '64k', source]);
    report.sourceSHA256 = hash(await fsp.readFile(source));
    report.fixtureSHA256 = hash(await fsp.readFile(wav));
    report.sourceProbe = JSON.parse(execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', source], { encoding: 'utf8' }));
    const probeFlac = path.join(media, 'probe.flac');
    await convert(['-i', source, '-c:a', 'flac', probeFlac]);
    report.initialFlacFormat = JSON.parse(execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', probeFlac], { encoding: 'utf8' })).streams[0];
    for (const mode of modes.filter(mode => mode.ext === 'flac')) mode.precision = report.initialFlacFormat.sample_fmt;
    report.intermediateFormats = modes.map(mode => ({mode:mode.name, sampleFormat:mode.precision}));
    await fsp.rm(probeFlac);
    await save();
    for (const mode of modes) {
      for (let round = 0; round < rounds; round++) {
        const order = round % 2 ? ['fused', 'baseline'] : ['baseline', 'fused'], outputs = {};
        for (const flow of order) outputs[flow] = await execute(mode, flow, source, path.join(media, mode.name + '-' + round + '-' + flow), round);
        if (round === 0) await compare(mode, outputs);
        for (const flow of order) await fsp.rm(path.dirname(outputs[flow].track), { recursive: true, force: true });
      }
    }
    assert.equal(hash(await fsp.readFile(source)), report.sourceSHA256, 'Source Opus unchanged');
    assert.equal(hash(await fsp.readFile(wav)), report.fixtureSHA256, 'Source PCM unchanged');
    report.sourcesUnchanged = true;
    report.summary = modes.map(mode => {
      const rows = flow => report.runs.filter(row => row.mode === mode.name && row.flow === flow);
      const before = rows('baseline'), after = rows('fused');
      const baselineCPU = median(before.map(row => row.cpuSeconds)), fusedCPU = median(after.map(row => row.cpuSeconds));
      const baselineWall = median(before.map(row => row.elapsedSeconds)), fusedWall = median(after.map(row => row.elapsedSeconds));
      return { mode: mode.name, baselineCPU, fusedCPU, cpuReductionPercent: 100 * (1 - fusedCPU / baselineCPU),
        baselineWall, fusedWall, wallReductionPercent: 100 * (1 - fusedWall / baselineWall),
        baselinePeakDisk: Math.max(...before.map(row => row.peakAllocatedDiskBytes)), fusedPeakDisk: Math.max(...after.map(row => row.peakAllocatedDiskBytes)),
        pairedCpuReductions: before.map(a => 100 * (1 - after.find(b => b.round === a.round).cpuSeconds / a.cpuSeconds)),
        baselineCPURange: [Math.min(...before.map(r => r.cpuSeconds)), Math.max(...before.map(r => r.cpuSeconds))],
        fusedCPURange: [Math.min(...after.map(r => r.cpuSeconds)), Math.max(...after.map(r => r.cpuSeconds))] };
    });
    report.allQualityChecksPassed = report.quality.every(row => row.qualityChecksPassed);
    report.memoryPeakBytes = Number(readGroup('memory.peak'));
    await save(); console.log(JSON.stringify({ summary: report.summary, quality: report.allQualityChecksPassed, memoryPeakBytes: report.memoryPeakBytes }, null, 2));
  } catch (error) {
    report.error = error.stack; await save(); throw error;
  } finally { await fsp.rm(media, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
