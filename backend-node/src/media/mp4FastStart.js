'use strict';

const fs = require('node:fs');

const { fail } = require('../audio/audioContract');

const CODE = 'MEDIA_EXPORT_OUTPUT_INVALID';
const MAX_TOP_LEVEL_ATOMS = 256;

function invalid() {
  fail(CODE);
}

async function readExactly(handle, buffer, position) {
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
  if (bytesRead !== buffer.length) invalid();
}

async function assertFastStartMp4(filePath, maximumBytes) {
  let handle;
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 24
      || stats.size > maximumBytes) invalid();
    handle = await fs.promises.open(filePath, 'r');
    let offset = 0;
    let atomCount = 0;
    let firstType = null;
    let moovOffset = null;
    let mdatOffset = null;
    while (offset < stats.size) {
      atomCount += 1;
      if (atomCount > MAX_TOP_LEVEL_ATOMS || stats.size - offset < 8) invalid();
      const header = Buffer.alloc(8);
      await readExactly(handle, header, offset);
      const size32 = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString('ascii');
      if (!/^[A-Za-z0-9 ]{4}$/u.test(type)) invalid();
      if (firstType === null) firstType = type;
      let atomSize = size32;
      let headerSize = 8;
      if (size32 === 1) {
        const extended = Buffer.alloc(8);
        await readExactly(handle, extended, offset + 8);
        const size64 = extended.readBigUInt64BE(0);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
        atomSize = Number(size64);
        headerSize = 16;
      } else if (size32 === 0) {
        atomSize = stats.size - offset;
      }
      if (!Number.isSafeInteger(atomSize) || atomSize < headerSize
        || offset + atomSize > stats.size) invalid();
      if (type === 'moov') {
        if (moovOffset !== null) invalid();
        moovOffset = offset;
      }
      if (type === 'mdat') {
        if (mdatOffset !== null) invalid();
        mdatOffset = offset;
      }
      offset += atomSize;
    }
    if (offset !== stats.size || firstType !== 'ftyp' || moovOffset === null
      || mdatOffset === null || moovOffset >= mdatOffset) invalid();
    return true;
  } catch {
    return invalid();
  } finally {
    try { await handle?.close(); } catch { /* output already fails closed above */ }
  }
}

module.exports = Object.freeze({ assertFastStartMp4 });
