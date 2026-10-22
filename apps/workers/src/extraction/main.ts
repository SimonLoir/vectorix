import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { parsePdf } from './pdf';
import {
    DOCX_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    DocumentParserError,
    LIMITS,
    validateExtraction,
    type ParserErrorCode,
    type StructuredExtraction,
} from './limits';

/** Workers own parsing; unexpected runtime failures become a safe operator diagnostic. */
export async function parseRichDocument(
    bytes: Uint8Array,
    mediaType: string
): Promise<StructuredExtraction> {
    try {
        return await parseSupportedDocument(bytes, mediaType);
    } catch (error) {
        if (error instanceof DocumentParserError) throw error;
        throw new DocumentParserError('PARSER_UNAVAILABLE');
    }
}

/** Workers own heavyweight parsers; callers retain checksums, authorization, leases, object I/O and publication. */
async function parseSupportedDocument(
    bytes: Uint8Array,
    mediaType: string
): Promise<StructuredExtraction> {
    if (!bytes.length || bytes.length > LIMITS.inputBytes)
        throw new DocumentParserError('PARSER_LIMIT');
    if (mediaType === PDF_MEDIA_TYPE) return await parsePdf(bytes);
    if (mediaType !== DOCX_MEDIA_TYPE)
        throw new DocumentParserError('FILE_INVALID');
    return new Promise((resolve, reject) => {
        const input = new Uint8Array(bytes);
        const builtWorker = new URL('docx-thread.mjs', import.meta.url);
        const workerEntry = existsSync(builtWorker)
            ? builtWorker
            : new URL('docx-thread.ts', import.meta.url);
        const worker = new Worker(workerEntry, {
            workerData: { bytes: input },
            execArgv: workerEntry.pathname.endsWith('.ts')
                ? ['--import', import.meta.resolve('tsx')]
                : [],
            transferList: [input.buffer],
            resourceLimits: {
                maxOldGenerationSizeMb: 128,
                maxYoungGenerationSizeMb: 16,
                stackSizeMb: 4,
            },
            env: {},
            stdout: true,
            stderr: true,
        });
        let settled = false,
            diagnosticBytes = 0;
        const finish = (
            error?: DocumentParserError,
            result?: StructuredExtraction
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            if (error) reject(error);
            else if (result) {
                try {
                    resolve(validateExtraction(result));
                } catch {
                    reject(new DocumentParserError('PARSER_LIMIT'));
                }
            }
        };
        const timer = setTimeout(
            () => finish(new DocumentParserError('PARSER_TIMEOUT')),
            LIMITS.timeoutMs
        );
        const drain = (chunk: Buffer) => {
            diagnosticBytes += chunk.length;
            if (diagnosticBytes > LIMITS.stderrBytes)
                finish(new DocumentParserError('PARSER_LIMIT'));
        };
        worker.stdout.on('data', drain);
        worker.stderr.on('data', drain);
        worker.on(
            'message',
            (message: {
                ok: boolean;
                code?: ParserErrorCode;
                result?: StructuredExtraction;
            }) => {
                if (message.ok && message.result)
                    finish(undefined, message.result);
                else
                    finish(
                        new DocumentParserError(message.code ?? 'FILE_INVALID')
                    );
            }
        );
        worker.on('error', (error: Error & { code?: string }) =>
            finish(
                new DocumentParserError(
                    error.code === 'ERR_WORKER_OUT_OF_MEMORY'
                        ? 'PARSER_LIMIT'
                        : 'PARSER_UNAVAILABLE'
                )
            )
        );
        worker.on('exit', () => {
            if (!settled) finish(new DocumentParserError('FILE_INVALID'));
        });
    });
}
export {
    DocumentParserError,
    DOCX_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    LIMITS,
} from './limits';
export type {
    StructuredExtraction,
    ExtractionSource,
    ParserErrorCode,
} from './limits';
