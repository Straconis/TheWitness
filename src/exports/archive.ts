import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

function checksum(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP STORE archives for bounded Discord attachments; no host zip utility needed. */
export async function archiveExport(directory: string, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, count = 0, total = 22;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(manifest\.json|notes\.json|transcript\.(txt|srt|vtt)|mix\.(ogg|wav|flac|mp3)|track-\d+\.(ogg|wav|flac|mp3))$/.test(entry.name)) continue;
    const name = Buffer.from(entry.name);
    const size = (await stat(path.join(directory, entry.name))).size;
    total += size + 30 + 46 + name.length * 2;
    if (total > limit || total > 0xffffffff || count >= 65535) throw new Error("Export is too large for a Discord attachment; the files remain saved on the host.");
    const data = await readFile(path.join(directory, entry.name));
    if (data.length !== size) throw new Error("Export changed while creating download.");
    const crc = checksum(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4);
    local.writeUInt16LE(0x21,12); // 1980-01-01, valid ZIP date
    local.writeUInt32LE(crc,14); local.writeUInt32LE(size,18); local.writeUInt32LE(size,22); local.writeUInt16LE(name.length,26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0); record.writeUInt16LE(20,4); record.writeUInt16LE(20,6);
    record.writeUInt16LE(0x21,14); record.writeUInt32LE(crc,16); record.writeUInt32LE(size,20); record.writeUInt32LE(size,24);
    record.writeUInt16LE(name.length,28); record.writeUInt32LE(offset,42);
    chunks.push(local,name,data); central.push(record,name);
    offset += local.length + name.length + size; count++;
  }
  if (!count) throw new Error("Export contains no files.");
  const directoryData = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(count,8); end.writeUInt16LE(count,10);
  end.writeUInt32LE(directoryData.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,directoryData,end]);
}
