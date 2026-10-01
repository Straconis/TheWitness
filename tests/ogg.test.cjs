const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeOggPage, BOS, EOS } = require('../dist/recording/ogg');
const crc32 = require('../dist/recording/crc32').default;

// Independent bit-by-bit checksum implementation to check the table-based port.
function checksum(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

test('Ogg CRC matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0x89a1897f);
});

for (const size of [0, 1, 254, 255, 256, 509, 510, 65024]) {
  test(`packet of ${size} bytes round trips with valid lacing and checksum`, () => {
    const packet = Buffer.alloc(size, 0xab);
    const granule = 0x123456789abcdef0n;
    const page = encodeOggPage(granule, 42, 7, packet, BOS | EOS);
    assert.equal(page.toString('ascii', 0, 4), 'OggS');
    assert.equal(page[4], 0);
    assert.equal(page[5], BOS | EOS);
    assert.equal(page.readBigUInt64LE(6), granule);
    assert.equal(page.readUInt32LE(14), 42);
    assert.equal(page.readUInt32LE(18), 7);
    const segments = page[26];
    const lacing = [...page.subarray(27, 27 + segments)];
    assert.equal(lacing.reduce((sum, n) => sum + n, 0), size);
    assert.ok(lacing.at(-1) < 255);
    assert.ok(lacing.slice(0, -1).every(n => n === 255));
    assert.deepEqual(page.subarray(27 + segments), packet);
    const actual = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    assert.equal(actual, checksum(page));
  });
}

test('rejects oversized packets and invalid numeric fields', () => {
  assert.throws(() => encodeOggPage(0, 1, 0, Buffer.alloc(65025)), RangeError);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 1n << 64n])
    assert.throws(() => encodeOggPage(value, 1, 0, Buffer.alloc(0)), RangeError);
  for (const value of [-1, 1.5, 0x100000000]) {
    assert.throws(() => encodeOggPage(0, value, 0, Buffer.alloc(0)), RangeError);
    assert.throws(() => encodeOggPage(0, 1, value, Buffer.alloc(0)), RangeError);
  }
  assert.throws(() => encodeOggPage(0, 1, 0, Buffer.alloc(0), 8), RangeError);
});
