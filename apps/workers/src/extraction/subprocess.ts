import { spawn } from 'node:child_process';
import { DocumentParserError, LIMITS } from './limits';
import { classifyPopplerResult } from './poppler-diagnostics';

/** No shell, inherited credentials, user-controlled executables or unbounded diagnostics. */
export function runPoppler(
    executable: '/usr/bin/pdfinfo' | '/usr/bin/pdftotext',
    args: readonly string[],
    deadline: number,
    maxStdout: number
): Promise<{ stdout: Buffer; stderr: string }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
        return Promise.reject(new DocumentParserError('PARSER_TIMEOUT'));
    return new Promise((resolve, reject) => {
        const child = spawn(
            '/usr/bin/prlimit',
            [
                '--cpu=20:20',
                '--as=536870912:536870912',
                '--nofile=64:64',
                '--',
                executable,
                ...args,
            ],
            {
                shell: false,
                env: {
                    PATH: '/usr/bin:/bin',
                    LANG: 'C',
                    LC_ALL: 'C',
                    TZ: 'UTC',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: '/tmp',
            }
        );
        const output: Buffer[] = [];
        const errors: Buffer[] = [];
        let outputBytes = 0,
            errorBytes = 0;
        let failure: DocumentParserError | undefined;
        let settled = false;
        const fail = (error: DocumentParserError) => {
            failure ??= error;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(
            () => fail(new DocumentParserError('PARSER_TIMEOUT')),
            remaining
        );
        child.stdout.on('data', (chunk: Buffer) => {
            outputBytes += chunk.length;
            if (outputBytes > maxStdout)
                fail(new DocumentParserError('PARSER_LIMIT'));
            else output.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            errorBytes += chunk.length;
            if (errorBytes > LIMITS.stderrBytes)
                fail(new DocumentParserError('PARSER_LIMIT'));
            else errors.push(chunk);
        });
        child.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new DocumentParserError('PARSER_UNAVAILABLE'));
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const stderr = Buffer.concat(errors).toString('utf8');
            if (failure) reject(failure);
            else {
                const diagnostic = classifyPopplerResult({
                    code,
                    signal,
                    stderr,
                });
                if (diagnostic) reject(new DocumentParserError(diagnostic));
                else resolve({ stdout: Buffer.concat(output), stderr });
            }
        });
    });
}
