import { parentPort, workerData } from 'node:worker_threads';
import { parseDocx } from './docx';
import { DocumentParserError } from './limits';

/** Isolated CPU/heap boundary. Only input bytes cross in and sanitized codes/structured text cross out. */
if (!parentPort) throw new Error('Parser entry requires a worker thread.');
try {
    const result = await parseDocx(workerData.bytes as Uint8Array);
    parentPort.postMessage({ ok: true, result });
} catch (error) {
    parentPort.postMessage({
        ok: false,
        code:
            error instanceof DocumentParserError ? error.code : 'FILE_INVALID',
    });
} finally {
    parentPort.close();
}
