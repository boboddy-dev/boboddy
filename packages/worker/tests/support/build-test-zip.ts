/**
 * Builds a minimal, valid (non-ZIP64) zip archive containing empty-content
 * entries with the given names, using the STORE (uncompressed) method.
 *
 * This is test-only scaffolding for exercising `detectArtifactKind`'s
 * content-based trace detection without needing to check a real
 * `trace.zip` fixture into `packages/worker`. Entry contents are always
 * empty — only entry *names* matter for that detection.
 */
export function buildTestZip(entryNames: string[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const name of entryNames) {
    const nameBytes = Buffer.from(name, "utf8");

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(0, 8); // compression method: 0 = store
    localHeader.writeUInt16LE(0, 10); // last mod file time
    localHeader.writeUInt16LE(0, 12); // last mod file date
    localHeader.writeUInt32LE(0, 14); // crc-32 (no content)
    localHeader.writeUInt32LE(0, 18); // compressed size
    localHeader.writeUInt32LE(0, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);
    localHeaders.push(localHeader);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory file header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(0, 10); // compression method
    centralHeader.writeUInt16LE(0, 12); // last mod file time
    centralHeader.writeUInt16LE(0, 14); // last mod file date
    centralHeader.writeUInt32LE(0, 16); // crc-32
    centralHeader.writeUInt32LE(0, 20); // compressed size
    centralHeader.writeUInt32LE(0, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBytes.length, 28); // file name length
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    nameBytes.copy(centralHeader, 46);
    centralHeaders.push(centralHeader);

    offset += localHeader.length;
  }

  const localSection = Buffer.concat(localHeaders);
  const centralSection = Buffer.concat(centralHeaders);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entryNames.length, 8); // records on this disk
  eocd.writeUInt16LE(entryNames.length, 10); // total records
  eocd.writeUInt32LE(centralSection.length, 12); // size of central directory
  eocd.writeUInt32LE(localSection.length, 16); // offset of start of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localSection, centralSection, eocd]);
}
