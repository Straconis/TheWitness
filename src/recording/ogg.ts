// Adapted from Craig's recorder/ogg.ts, commit 60d1a00.
// Copyright and permission notice: licenses/Craig-ISC.txt.
import crc32 from "./crc32";

export const BOS = 2;
export const EOS = 4;

/** One complete packet per page, as used by Craig's split recording files. */
export function encodeOggPage(
  granulePos: number | bigint,
  streamNo: number,
  packetNo: number,
  packet: Buffer,
  flags = 0
): Buffer {
  if (typeof granulePos === "number" && !Number.isSafeInteger(granulePos)) {
    throw new RangeError("Granule position must be a safe integer or bigint.");
  }
  const granule = BigInt(granulePos);
  if (granule < 0n || granule > 0xffffffffffffffffn) {
    throw new RangeError("Granule position must fit an unsigned 64-bit integer.");
  }
  for (const value of [streamNo, packetNo]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError("Stream and page numbers must fit unsigned 32-bit integers.");
    }
  }
  // A terminating segment of <255 bytes is required, even for exact multiples.
  const segments = Math.floor(packet.length / 255) + 1;
  if (segments > 255) {
    throw new RangeError("Packet requires multiple Ogg pages; maximum is 65024 bytes.");
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 7) {
    throw new RangeError("Invalid Ogg page flags.");
  }
  const headerLength = 27 + segments;
  const page = Buffer.alloc(headerLength + packet.length);
  page.write("OggS");
  page[5] = flags;
  page.writeBigUInt64LE(granule, 6);
  page.writeUInt32LE(streamNo, 14);
  page.writeUInt32LE(packetNo, 18);
  page[26] = segments;
  page.fill(255, 27, 27 + segments - 1);
  page[27 + segments - 1] = packet.length % 255;
  packet.copy(page, headerLength);
  page.writeUInt32LE(crc32(page), 22);
  return page;
}
