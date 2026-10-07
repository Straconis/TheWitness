import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

/** ZIP STORE archives for bounded Discord attachments; no host zip utility needed. */
export async function archiveExport(directory: string, limit: number): Promise<Buffer> {
  // Project ZIPs contain nested Audacity media and must be delivered intact.
  try{const project=path.join(directory,"project.zip"),info=await stat(project);if(info.size>limit)throw Error("Export is too large for a Discord attachment; the files remain saved on the host.");const bytes=await readFile(project);if(bytes.length!==info.size)throw Error("Export changed while creating download.");return bytes;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const chunks: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, count = 0, total = 22;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(manifest\.json|notes\.json|session\.(sesx|aup)|transcript\.(txt|srt|vtt)|mix\.(ogg|wav|flac|mp3|m4a)|track-\d+\.(ogg|wav|flac|mp3|m4a))$/.test(entry.name)) continue;
    const name = Buffer.from(entry.name);
    const size = (await stat(path.join(directory, entry.name))).size;
    total += size + 30 + 46 + name.length * 2;
    if (total > limit || total > 0xffffffff || count >= 65535) throw new Error("Export is too large for a Discord attachment; the files remain saved on the host.");
    const data = await readFile(path.join(directory, entry.name));
    if (data.length !== size) throw new Error("Export changed while creating download.");
    const crc = crc32(data);
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
