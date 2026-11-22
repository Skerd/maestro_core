/**
 * Reads the entry names of an OLE2 compound file: the container of Office 97-2003 documents (.doc, .xls, .ppt) and of
 * objects embedded in current Office files. Upload checks use the names to find macros and embedded objects without a
 * new dependency; stream contents are not read.
 */

const SIGNATURE = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
const HEADER_BYTES = 512;
const HEADER_FAT_SLOTS = 109;
const DIRECTORY_ENTRY_BYTES = 128;
/** Sector ids above this mark the end of a chain or a free sector. */
const MAX_REGULAR_SECTOR = 0xFFFFFFFA;

export function isOleCompoundFile(buffer: Buffer): boolean {
    return buffer.length >= HEADER_BYTES && buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE);
}

/** The name of every storage and stream in the file. Throws when the file's structure does not hold together. */
export function oleEntryNames(buffer: Buffer): string[] {
    if (!isOleCompoundFile(buffer)) throw new Error('Not an OLE2 compound file');
    const sectorShift = buffer.readUInt16LE(30);
    if (sectorShift !== 9 && sectorShift !== 12) throw new Error(`Unsupported sector size 2^${sectorShift}`);
    const sectorSize = 1 << sectorShift;
    const idsPerSector = sectorSize / 4;
    // Sector 0 starts right after the header, which fills the first sector-sized block.
    const sectorOffset = (id: number): number => {
        const offset = (id + 1) * sectorSize;
        if (id > MAX_REGULAR_SECTOR || offset + sectorSize > buffer.length) throw new Error(`Sector ${id} is outside the file`);
        return offset;
    };

    // The FAT's own sectors: the first 109 are listed in the header, the rest in a chain of DIFAT sectors.
    const fatSectorCount = buffer.readUInt32LE(44);
    const fatSectors: number[] = [];
    for (let slot = 0; slot < HEADER_FAT_SLOTS && fatSectors.length < fatSectorCount; slot++) {
        fatSectors.push(buffer.readUInt32LE(76 + slot * 4));
    }
    let difatSector = buffer.readUInt32LE(68);
    for (let remaining = buffer.readUInt32LE(72); remaining > 0 && fatSectors.length < fatSectorCount; remaining--) {
        const offset = sectorOffset(difatSector);
        for (let slot = 0; slot < idsPerSector - 1 && fatSectors.length < fatSectorCount; slot++) {
            fatSectors.push(buffer.readUInt32LE(offset + slot * 4));
        }
        difatSector = buffer.readUInt32LE(offset + (idsPerSector - 1) * 4);
    }
    if (fatSectors.length < fatSectorCount) throw new Error('The FAT is incomplete');
    const nextSector = (id: number): number => {
        const fatSector = fatSectors[Math.floor(id / idsPerSector)];
        if (fatSector === undefined) throw new Error(`Sector ${id} has no FAT entry`);
        return buffer.readUInt32LE(sectorOffset(fatSector) + (id % idsPerSector) * 4);
    };

    const names: string[] = [];
    const visited = new Set<number>();
    for (let sector = buffer.readUInt32LE(48); sector <= MAX_REGULAR_SECTOR; sector = nextSector(sector)) {
        if (visited.has(sector)) throw new Error('The directory chain loops');
        visited.add(sector);
        const offset = sectorOffset(sector);
        for (let entry = offset; entry < offset + sectorSize; entry += DIRECTORY_ENTRY_BYTES) {
            const type = buffer[entry + 66]; // 0 unused, 1 storage, 2 stream, 5 root
            const nameBytes = buffer.readUInt16LE(entry + 64); // UTF-16LE, counting the closing NUL
            if (type === 0 || nameBytes < 2 || nameBytes > 64) continue;
            names.push(buffer.toString('utf16le', entry, entry + nameBytes - 2));
        }
    }
    return names;
}
