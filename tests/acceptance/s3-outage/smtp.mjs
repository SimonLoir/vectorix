/** Private loopback SMTP capture only; no public inbox, proof redemption or external transport. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    context,
    receiptScope,
    need,
    RecipeError,
    writePrivate,
    entryError,
} from './private.mjs';

export const STATIC_DRAFT_ONLY = true;
const MAX_MESSAGES = 32,
    MAX_MESSAGE_BYTES = 64 * 1024,
    MAX_TOTAL_BYTES = 2 * 1024 * 1024;

async function main() {
    need(!STATIC_DRAFT_ONLY, 'M7C_S3_OUTAGE_SMTP_DRAFT_REVIEW_REQUIRED');
    const { state, run, directory } = context(process.argv.slice(2), 'smtp');
    Object.assign(process.env, state.environment, {
        VECTORIX_M7C_S3_OUTAGE_RUN: run,
        VECTORIX_M7C_S3_OUTAGE_ROLE: 'smtp',
        VECTORIX_M7C_S3_SCENARIO: state.scenario,
    });
    need(
        state.environment.VECTORIX_DEFAULT_SMTP_HOST === '127.0.0.1' &&
            state.environment.VECTORIX_DEFAULT_SMTP_PORT ===
                String(state.ports.smtp) &&
            state.environment.VECTORIX_DEFAULT_SMTP_SENDER_EMAIL ===
                'ownership@example.test' &&
            state.environment.VECTORIX_DEFAULT_SMTP_USER === '' &&
            state.environment.VECTORIX_DEFAULT_SMTP_PASSWORD === '',
        'M7C_S3_OUTAGE_SMTP_BINDING'
    );
    const mailDirectory = path.join(directory, 'mail');
    need(
        !fs.existsSync(path.join(directory, 'smtp-intent.json')) &&
            !fs.existsSync(mailDirectory),
        'M7C_S3_OUTAGE_SMTP_NO_REPLAY'
    );
    writePrivate(path.join(directory, 'smtp-intent.json'), {
        ...receiptScope(state),
        runId: run,
        status: 'STARTED_CAPTURE_NOT_BROWSER_ACCEPTANCE',
    });
    fs.mkdirSync(mailDirectory, { mode: 0o700 });
    const sockets = new Set();
    let connections = 0,
        messageCount = 0,
        acceptedBytes = 0,
        refusals = 0,
        stopping = false;

    function saveMessage(to, bytes) {
        need(
            messageCount < MAX_MESSAGES &&
                bytes.length <= MAX_MESSAGE_BYTES &&
                acceptedBytes + bytes.length <= MAX_TOTAL_BYTES,
            'M7C_S3_OUTAGE_SMTP_CAPTURE_BOUND'
        );
        const info = fs.lstatSync(mailDirectory);
        need(
            info.isDirectory() &&
                info.uid === process.getuid() &&
                (info.mode & 0o777) === 0o700 &&
                fs.realpathSync(mailDirectory) === mailDirectory,
            'M7C_S3_OUTAGE_SMTP_PRIVATE_DIRECTORY'
        );
        const ordinal = messageCount + 1;
        const payload = Buffer.from(
            JSON.stringify({
                ...receiptScope(state),
                runId: run,
                ordinal,
                to,
                mimeBase64: bytes.toString('base64'),
            }) + '\n'
        );
        need(
            payload.length <= 96 * 1024,
            'M7C_S3_OUTAGE_SMTP_PRIVATE_MESSAGE_BOUND'
        );
        const filename = path.join(
            mailDirectory,
            `mail-${String(ordinal).padStart(4, '0')}.json`
        );
        const descriptor = fs.openSync(
            filename,
            fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_WRONLY |
                fs.constants.O_NOFOLLOW,
            0o600
        );
        try {
            fs.writeFileSync(descriptor, payload);
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        const parent = fs.openSync(
            mailDirectory,
            fs.constants.O_RDONLY |
                fs.constants.O_DIRECTORY |
                fs.constants.O_NOFOLLOW
        );
        try {
            fs.fsyncSync(parent);
        } finally {
            fs.closeSync(parent);
        }
        messageCount = ordinal;
        acceptedBytes += bytes.length;
    }

    const server = net.createServer((socket) => {
        if (
            ++connections > 64 ||
            sockets.size >= 4 ||
            socket.remoteAddress !== '127.0.0.1' ||
            socket.localAddress !== '127.0.0.1' ||
            socket.localPort !== state.ports.smtp
        ) {
            refusals++;
            socket.destroy();
            return;
        }
        sockets.add(socket);
        socket.setTimeout(5000, () => socket.destroy());
        const connectionDeadline = setTimeout(() => socket.destroy(), 30000);
        socket.on('error', () => {
            refusals++;
        });
        socket.on('close', () => {
            clearTimeout(connectionDeadline);
            sockets.delete(socket);
        });
        socket.write('220 controlled.example.test ESMTP\r\n');
        let pending = Buffer.alloc(0),
            receivedBytes = 0,
            commandCount = 0;
        let sender = false,
            recipient = null,
            data = null,
            dataBytes = 0;
        const refuse = () => {
            refusals++;
            socket.destroy();
        };
        socket.on('data', (part) => {
            try {
                receivedBytes += part.length;
                if (receivedBytes > 128 * 1024) {
                    refuse();
                    return;
                }
                pending = Buffer.concat([pending, part]);
                let end;
                while ((end = pending.indexOf('\r\n')) >= 0) {
                    const line = pending.subarray(0, end);
                    pending = pending.subarray(end + 2);
                    if (data !== null) {
                        if (line.length === 1 && line[0] === 46) {
                            if (!sender || !recipient) {
                                refuse();
                                return;
                            }
                            saveMessage(recipient, Buffer.concat(data));
                            data = null;
                            sender = false;
                            recipient = null;
                            socket.write('250 Message accepted\r\n');
                            continue;
                        }
                        const unstuffed =
                            line[0] === 46 ? line.subarray(1) : line;
                        dataBytes += unstuffed.length + 2;
                        if (
                            dataBytes > MAX_MESSAGE_BYTES ||
                            data.length >= 1024
                        ) {
                            refuse();
                            return;
                        }
                        data.push(Buffer.from(unstuffed), Buffer.from('\r\n'));
                        continue;
                    }
                    if (
                        ++commandCount > 64 ||
                        line.length > 2048 ||
                        [...line].some((byte) => byte < 32 || byte > 126)
                    ) {
                        refuse();
                        return;
                    }
                    const command = line.toString('ascii');
                    if (/^(?:EHLO|HELO) .{1,200}$/iu.test(command)) {
                        socket.write('250 controlled.example.test\r\n');
                    } else if (
                        /^MAIL FROM:<ownership@example\.test>$/iu.test(command)
                    ) {
                        sender = true;
                        recipient = null;
                        socket.write('250 Sender accepted\r\n');
                    } else if (/^RCPT TO:</iu.test(command)) {
                        const address =
                            /^RCPT TO:<([A-Za-z0-9._+-]{1,200}@example\.test)>$/iu.exec(
                                command
                            )?.[1];
                        if (!sender || recipient !== null || !address) {
                            refuse();
                            return;
                        }
                        recipient = address;
                        socket.write('250 Recipient accepted\r\n');
                    } else if (command.toUpperCase() === 'DATA') {
                        if (
                            !sender ||
                            !recipient ||
                            messageCount >= MAX_MESSAGES
                        ) {
                            refuse();
                            return;
                        }
                        data = [];
                        dataBytes = 0;
                        socket.write('354 End with a dot\r\n');
                    } else if (command.toUpperCase() === 'QUIT') {
                        socket.end('221 Bye\r\n');
                        return;
                    } else if (/^(?:RSET|NOOP)$/iu.test(command)) {
                        sender = false;
                        recipient = null;
                        socket.write('250 OK\r\n');
                    } else {
                        refuse();
                        return;
                    }
                }
                if (pending.length > MAX_MESSAGE_BYTES) refuse();
            } catch {
                refuse();
                shutdown(true);
            }
        });
    });

    function shutdown(failed = false) {
        if (stopping) return;
        stopping = true;
        if (failed) process.exitCode = 1;
        for (const socket of sockets) socket.destroy();
        server.close(() => {
            try {
                writePrivate(path.join(directory, 'smtp-stop.json'), {
                    ...receiptScope(state),
                    runId: run,
                    connections,
                    messages: messageCount,
                    acceptedBytes,
                    refusals,
                    failed,
                });
            } catch {
                process.exitCode = 1;
            }
        });
    }
    server.maxConnections = 4;
    server.on('error', () => shutdown(true));
    await new Promise((resolve, reject) => {
        server.once('error', () =>
            reject(new RecipeError('M7C_S3_OUTAGE_SMTP_LISTEN_REFUSED'))
        );
        server.listen(state.ports.smtp, '127.0.0.1', resolve);
    });
    try {
        writePrivate(path.join(directory, 'smtp-ready.json'), {
            ...receiptScope(state),
            runId: run,
            smtpPort: state.ports.smtp,
            scope: 'OWNED_LOOPBACK_CAPTURE_ONLY',
        });
    } catch (error) {
        shutdown(true);
        throw error;
    }
    for (const signal of ['SIGTERM', 'SIGINT'])
        process.once(signal, () => shutdown());
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
