"use strict";

/**
 * A minimal reader for .zip files, enough for GTFS archives:
 * stored and deflated entries, read as streams, so a large stop_times.txt
 * never has to fit in memory. Zip64 archives are not supported.
 */

const fs = require("node:fs");
const { pipeline } = require("node:stream");
const zlib = require("node:zlib");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

class ZipArchive {
  constructor(path, entries) {
    this.path = path;
    this.entries = entries;
  }

  static async open(path) {
    const handle = await fs.promises.open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size < EOCD_SIZE) {
        throw new Error("not a zip file (too small)");
      }

      const tailSize = Math.min(size, EOCD_SIZE + MAX_COMMENT_SIZE);
      const tail = await readAt(handle, size - tailSize, tailSize);

      let eocd = -1;
      for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) {
        throw new Error("not a zip file (no end of central directory)");
      }

      const count = tail.readUInt16LE(eocd + 10);
      const directorySize = tail.readUInt32LE(eocd + 12);
      const directoryOffset = tail.readUInt32LE(eocd + 16);
      if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
        throw new Error("zip64 archives are not supported");
      }

      const directory = await readAt(handle, directoryOffset, directorySize);
      const entries = new Map();
      let position = 0;

      for (let i = 0; i < count; i++) {
        if (position + 46 > directory.length || directory.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
          throw new Error("corrupt zip central directory");
        }
        const flags = directory.readUInt16LE(position + 8);
        const nameLength = directory.readUInt16LE(position + 28);
        const extraLength = directory.readUInt16LE(position + 30);
        const commentLength = directory.readUInt16LE(position + 32);
        const name = directory.toString("utf8", position + 46, position + 46 + nameLength);

        entries.set(name, {
          name,
          encrypted: (flags & 1) !== 0,
          method: directory.readUInt16LE(position + 10),
          compressedSize: directory.readUInt32LE(position + 20),
          size: directory.readUInt32LE(position + 24),
          localOffset: directory.readUInt32LE(position + 42)
        });
        position += 46 + nameLength + extraLength + commentLength;
      }

      return new ZipArchive(path, entries);
    } finally {
      await handle.close();
    }
  }

  /** Finds an entry by file name, also when the archive keeps files in a folder. */
  find(fileName) {
    if (this.entries.has(fileName)) {
      return this.entries.get(fileName);
    }
    for (const [name, entry] of this.entries) {
      if (name.endsWith(`/${fileName}`)) {
        return entry;
      }
    }
    return null;
  }

  has(fileName) {
    return this.find(fileName) !== null;
  }

  /** @returns {Promise<import("node:stream").Readable>} the uncompressed content of an entry */
  async read(fileName) {
    const entry = this.find(fileName);
    if (!entry) {
      throw new Error(`${fileName} not found in ${this.path}`);
    }
    if (entry.encrypted) {
      throw new Error(`${fileName} is encrypted`);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`${fileName} uses unsupported compression method ${entry.method}`);
    }
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff) {
      throw new Error("zip64 entries are not supported");
    }

    const handle = await fs.promises.open(this.path, "r");
    let dataStart;
    try {
      const header = await readAt(handle, entry.localOffset, 30);
      if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        throw new Error(`corrupt local header for ${fileName}`);
      }
      dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    } finally {
      await handle.close();
    }

    if (entry.compressedSize === 0) {
      return fs.createReadStream(this.path, { start: 0, end: -1 });
    }

    const raw = fs.createReadStream(this.path, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
    if (entry.method === 0) {
      return raw;
    }

    const inflate = zlib.createInflateRaw();
    // pipeline() forwards a read error to the inflate stream, so the consumer sees it.
    pipeline(raw, inflate, () => {});
    return inflate;
  }
}

module.exports = { ZipArchive };
