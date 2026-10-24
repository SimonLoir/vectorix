/** Closed private-file curl transport. No network or filesystem I/O occurs on import. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { need } from '../s3-outage/private.mjs';
export const STATIC_DRAFT_ONLY = true;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quote = (value) => {
    need(
        typeof value === 'string' &&
            value.length <= 16384 &&
            !/[\r\n\0]/u.test(value),
        'S3_OUTAGE_CURL_CONFIG_VALUE'
    );
    return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
};
/** Only the exact native auth/key and document transport routes are available. */
export function assertCurlRoute(origin, route, method) {
    need(
        /^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}$/u.test(origin) &&
            Number(new URL(origin).port) <= 65535,
        'S3_OUTAGE_CURL_ORIGIN'
    );
    const auth = [
        '/api/auth/sign-in/email',
        '/api/auth/organization/set-active',
        '/api/auth/sign-out',
        '/rpc/v1/admin/organization/apiKeys/create',
    ];
    const post =
        auth.includes(route) ||
        route === '/api/v1/admin/rag/documents/uploads' ||
        /^\/api\/v1\/admin\/rag\/documents\/[A-Za-z0-9_-]{1,128}\/replacements$/u.test(
            route
        );
    const get =
        route === '/api/auth/get-session' ||
        /^\/api\/v1\/admin\/rag\/documents\/[A-Za-z0-9_-]{1,128}\/(?:preview|original)$/u.test(
            route
        );
    need(
        (method === 'POST' && post) || (method === 'GET' && get),
        'S3_OUTAGE_CURL_CLOSED_ROUTE'
    );
}
/** Parse bounded native HTTP/1.1 headers without placing response text in a diagnostic. */
export function parseCurlResponse(bytes) {
    need(
        Buffer.isBuffer(bytes) && bytes.length <= 81920,
        'S3_OUTAGE_CURL_RESPONSE_BOUND'
    );
    const split = bytes.indexOf('\r\n\r\n');
    need(split >= 0 && split <= 16384, 'S3_OUTAGE_CURL_HEADERS');
    const lines = bytes.subarray(0, split).toString('latin1').split('\r\n'),
        status = /^HTTP\/1\.1 (\d{3}) [^\r\n]*$/u.exec(lines.shift());
    need(
        status &&
            Number(status[1]) >= 200 &&
            Number(status[1]) <= 599 &&
            lines.length <= 80,
        'S3_OUTAGE_CURL_STATUS'
    );
    const headers = [];
    for (const line of lines) {
        const part = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n\0]*)$/u.exec(
            line
        );
        need(part && part[2].length <= 8192, 'S3_OUTAGE_CURL_HEADERS');
        headers.push([part[1].toLowerCase(), part[2]]);
    }
    const body = bytes.subarray(split + 4);
    need(body.length <= 65536, 'S3_OUTAGE_CURL_BODY_BOUND');
    return { status: Number(status[1]), headers, body };
}
/** One child, no retries/redirect/proxy/.curlrc; all secret headers/bodies live only in exclusive 0600 files. */
export function runPrivateCurl(input, execute = spawnSync) {
    need(!STATIC_DRAFT_ONLY, 'S3_OUTAGE_CURL_DRAFT_REVIEW_REQUIRED');
    const {
        directory,
        origin,
        route,
        method,
        headers,
        body,
        admit,
        curl,
        remainingMilliseconds,
    } = input;
    assertCurlRoute(origin, route, method);
    need(
        typeof admit === 'function' &&
            typeof remainingMilliseconds === 'function',
        'S3_OUTAGE_CURL_ADMISSION'
    );
    admit();
    const info = fs.lstatSync(directory);
    need(
        info.isDirectory() &&
            info.uid === process.getuid() &&
            (info.mode & 0o777) === 0o700 &&
            fs.realpathSync(directory) === directory,
        'S3_OUTAGE_CURL_DIRECTORY'
    );
    need(
        curl?.path === '/usr/bin/curl' &&
            fs.realpathSync(curl.path) === curl.path &&
            /^[a-f\d]{64}$/u.test(curl.sha256),
        'S3_OUTAGE_CURL_PIN'
    );
    const descriptor = fs.openSync(
        curl.path,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const bin = fs.fstatSync(descriptor);
        need(
            bin.isFile() &&
                bin.uid === 0 &&
                (bin.mode & 0o022) === 0 &&
                bin.size > 0 &&
                bin.size <= 16 * 1024 * 1024,
            'S3_OUTAGE_CURL_PIN'
        );
        const bytes = fs.readFileSync(descriptor);
        need(
            bytes.length === bin.size &&
                bytes.length <= 16 * 1024 * 1024 &&
                sha(bytes) === curl.sha256,
            'S3_OUTAGE_CURL_PIN'
        );
    } finally {
        fs.closeSync(descriptor);
    }
    need(
        Array.isArray(headers) &&
            headers.length <= 6 &&
            headers.every(
                ([name, value]) =>
                    [
                        'Cookie',
                        'Origin',
                        'content-type',
                        'Vectorix-CSRF',
                        'x-api-key',
                        'Vectorix-Expected-Organization-Id',
                    ].includes(name) &&
                    typeof value === 'string' &&
                    value.length <= 16384 &&
                    !/[\r\n\0]/u.test(value)
            ),
        'S3_OUTAGE_CURL_HEADERS'
    );
    need(
        !(
            headers.some(([n]) => n === 'Cookie') &&
            headers.some(([n]) => n === 'x-api-key')
        ),
        'S3_OUTAGE_CURL_AUTH_SEPARATION'
    );
    need(
        body === undefined ||
            (Buffer.isBuffer(body) &&
                body.length > 0 &&
                body.length <= 16384 &&
                method === 'POST'),
        'S3_OUTAGE_CURL_REQUEST_BOUND'
    );
    const prefix = path.join(
            directory,
            'curl-' + randomBytes(8).toString('hex')
        ),
        config = prefix + '.conf',
        payload = prefix + '.body',
        files = [];
    function privateFile(file, bytes) {
        const fd = fs.openSync(
            file,
            fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW,
            0o600
        );
        files.push(file);
        try {
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }
    try {
        if (body) privateFile(payload, body);
        const budget = Math.min(15000, Math.floor(remainingMilliseconds()));
        need(budget >= 1, 'S3_OUTAGE_CURL_DEADLINE');
        const entries = [
            'silent',
            'http1.1',
            'include',
            'no-buffer',
            'proxy = ""',
            'noproxy = "*"',
            'max-redirs = 0',
            'connect-timeout = 2',
            'max-time = ' + (budget / 1000).toFixed(3),
            'max-filesize = 65536',
            'url = ' + quote(origin + route),
            'request = ' + quote(method),
            'header = "Expect:"',
            ...headers.map(
                ([name, value]) => 'header = ' + quote(name + ': ' + value)
            ),
            ...(body ? ['data-binary = ' + quote('@' + payload)] : []),
        ];
        privateFile(config, entries.join('\n') + '\n');
        admit();
        const remaining = Math.min(budget, Math.floor(remainingMilliseconds()));
        need(remaining >= 1, 'S3_OUTAGE_CURL_DEADLINE');
        const result = execute(curl.path, ['-q', '--config', config], {
            cwd: directory,
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
            timeout: remaining,
            maxBuffer: 81920,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        need(
            !result.error && result.status === 0 && remainingMilliseconds() > 0,
            'S3_OUTAGE_CURL_UNKNOWN_ACCEPTANCE_NO_RETRY'
        );
        const response = parseCurlResponse(result.stdout);
        admit();
        need(remainingMilliseconds() > 0, 'S3_OUTAGE_CURL_DEADLINE');
        return response;
    } finally {
        for (const file of files) fs.unlinkSync(file);
    }
}
