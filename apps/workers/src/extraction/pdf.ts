import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { runPoppler } from './subprocess';
import {
    DocumentParserError,
    LIMITS,
    hasUsableText,
    validateExtraction,
    type StructuredExtraction,
} from './limits';

// eslint-disable-next-line unicorn/text-encoding-identifier-case -- Poppler's encoding map is named UTF-8.
const PDF_ENCODING = 'UTF-8';

/** A bounded native subprocess keeps PDF parsing off BullMQ's event loop. No rendering or OCR is performed. */
export async function parsePdf(
    bytes: Uint8Array
): Promise<StructuredExtraction> {
    if (
        !Buffer.from(bytes.subarray(0, 8)).toString('ascii').startsWith('%PDF-')
    )
        throw new DocumentParserError('FILE_INVALID');
    const deadline = Date.now() + LIMITS.timeoutMs;
    const directory = await mkdtemp(
        nodePath.join(tmpdir(), 'vectorix-parser-')
    );
    try {
        const path = nodePath.join(directory, 'source.pdf');
        await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        const info = await runPoppler(
            '/usr/bin/pdfinfo',
            ['-enc', PDF_ENCODING, path],
            deadline,
            64 * 1024
        );
        if (
            [
                ...info.stdout
                    .toString('utf8')
                    .matchAll(/^Encrypted:\s+(yes|no)\b/gm),
            ].at(-1)?.[1] === 'yes'
        )
            throw new DocumentParserError('PDF_ENCRYPTED');
        // Poppler prints trusted structural fields after untrusted Info dictionary entries.
        const matches = [
            ...info.stdout.toString('utf8').matchAll(/^Pages:\s+(\d+)\s*$/gm),
        ];
        const pages = Number(matches.at(-1)?.[1]);
        if (!Number.isSafeInteger(pages) || pages < 1)
            throw new DocumentParserError('FILE_INVALID');
        if (pages > LIMITS.pdfPages)
            throw new DocumentParserError('PARSER_LIMIT');
        // Keep the native form-feed separators: there is one per physical page, including empty pages.
        const converted = await runPoppler(
            '/usr/bin/pdftotext',
            ['-enc', PDF_ENCODING, '-eol', 'unix', path, '-'],
            deadline,
            LIMITS.textBytes + LIMITS.pdfPages
        );
        let decoded: string;
        try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(
                converted.stdout
            );
        } catch {
            throw new DocumentParserError('FILE_INVALID');
        }
        if (decoded.includes('\0'))
            throw new DocumentParserError('FILE_INVALID');
        const pageTexts = decoded.split('\f');
        if (pageTexts.at(-1) === '') pageTexts.pop();
        if (pageTexts.length !== pages)
            throw new DocumentParserError('FILE_INVALID');
        const result: StructuredExtraction = {
            schemaVersion: 1,
            format: 'PDF',
            text: '',
            sources: [],
            warnings: [],
        };
        for (const [index, raw] of pageTexts.entries()) {
            const text = raw.replaceAll(/\r\n?/g, '\n').trim();
            if (index > 0) result.text += '\n\n';
            const start = result.text.length;
            result.text += text;
            result.sources.push({
                kind: 'pdf-page',
                index,
                start,
                end: result.text.length,
                page: index + 1,
            });
            if (!hasUsableText(text))
                result.warnings.push({ code: 'NO_TEXT', sourceIndex: index });
        }
        if (!hasUsableText(result.text))
            throw new DocumentParserError('PDF_OCR_UNAVAILABLE');
        return validateExtraction(result);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
