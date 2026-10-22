import { crc32 } from 'node:zlib';
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';
import { DocumentParserError, LIMITS } from './limits';
import { canonicalName } from './docx-paths';
import { invalid } from './docx-xml';
export interface XmlBudget {
    bytes: number;
    read: Set<Entry>;
}
/** Stream and checksum one bounded XML part before decoding it. */
export async function readPart(
    zip: ZipFile,
    entry: Entry,
    max: number,
    budget: XmlBudget
) {
    if (entry.uncompressedSize > max)
        throw new DocumentParserError('PARSER_LIMIT');
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let bytes = 0,
        checksum = 0;
    try {
        for await (const value of stream) {
            const chunk = Buffer.from(value as Uint8Array);
            bytes += chunk.length;
            budget.bytes += chunk.length;
            if (bytes > max || budget.bytes > LIMITS.totalXmlBytes)
                throw new DocumentParserError('PARSER_LIMIT');
            checksum = crc32(chunk, checksum);
            chunks.push(chunk);
        }
        if (bytes !== entry.uncompressedSize || checksum !== entry.crc32)
            throw invalid();
        budget.read.add(entry);
        return Buffer.concat(chunks, bytes);
    } finally {
        stream.destroy();
    }
}

/** Preflight the entire central directory before inflating any user data. */
export async function openDocxArchive(bytes: Uint8Array) {
    let zip: ZipFile | undefined;
    try {
        zip = await fromBufferPromise(
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            {
                lazyEntries: true,
                autoClose: false,
                validateEntrySizes: true,
                strictFileNames: true,
            }
        );
        if (zip.entryCount > LIMITS.zipEntries)
            throw new DocumentParserError('PARSER_LIMIT');
        const entries = new Map<string, Entry>();
        let declaredBytes = 0;
        for await (const entry of zip.eachEntry()) {
            const name = canonicalName(entry.fileName);
            if (
                entries.has(name) ||
                entry.isEncrypted() ||
                (entry.generalPurposeBitFlag & 0x20_41) !== 0 ||
                ![0, 8].includes(entry.compressionMethod) ||
                ((entry.externalFileAttributes >>> 16) & 0xf0_00) === 0xa0_00
            )
                throw invalid();
            if (
                !Number.isSafeInteger(entry.uncompressedSize) ||
                !Number.isSafeInteger(entry.compressedSize) ||
                entry.compressedSize < 0 ||
                entry.compressedSize > bytes.length ||
                entry.uncompressedSize < 0
            )
                throw invalid();
            declaredBytes += entry.uncompressedSize;
            if (
                declaredBytes > LIMITS.zipDeclaredBytes ||
                entries.size >= LIMITS.zipEntries
            )
                throw new DocumentParserError('PARSER_LIMIT');
            if (/vbaproject|vbadata|macros/i.test(name)) throw invalid();
            entries.set(name, entry);
        }
        return { zip, entries };
    } catch (error) {
        zip?.close();
        throw error;
    }
}

/** Validate unused media and annotations too, without retaining their uncompressed bytes. */
export async function verifyUnusedParts(
    zip: ZipFile,
    entries: Map<string, Entry>,
    budget: XmlBudget
) {
    let actualBytes = budget.bytes;
    for (const entry of entries.values()) {
        if (budget.read.has(entry)) continue;
        const stream = await zip.openReadStreamPromise(entry);
        let length = 0,
            checksum = 0;
        try {
            for await (const value of stream) {
                const chunk = Buffer.from(value as Uint8Array);
                length += chunk.length;
                actualBytes += chunk.length;
                if (actualBytes > LIMITS.zipDeclaredBytes)
                    throw new DocumentParserError('PARSER_LIMIT');
                checksum = crc32(chunk, checksum);
            }
            if (length !== entry.uncompressedSize || checksum !== entry.crc32)
                throw invalid();
        } finally {
            stream.destroy();
        }
    }
}
