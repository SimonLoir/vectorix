import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';

/** Decode the actual one-part HTML MIME message produced by Nodemailer. */
export function htmlPart(message: string) {
    const separator = message.indexOf('\r\n\r\n');
    assert.ok(separator > 0, 'SMTP must capture a complete MIME message.');
    const headers = message.slice(0, separator);
    const body = message.slice(separator + 4);
    assert.match(headers, /content-type:\s*text\/html/i);
    if (/content-transfer-encoding:\s*base64/i.test(headers))
        return Buffer.from(body.replaceAll(/\s/g, ''), 'base64').toString(
            'utf8'
        );
    if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
        const decoded = body
            .replaceAll('=\r\n', '')
            .replaceAll(/=([a-f\d]{2})/gi, (_match, hex: string) =>
                String.fromCodePoint(Number.parseInt(hex, 16))
            );
        return Buffer.from(decoded, 'latin1').toString('utf8');
    }
    return body;
}

/**
 * Owned loopback SMTP, not a mail-service mock. DATA and connection counts are
 * bounded; it refuses recipients outside the synthetic example.test domain.
 */
export async function smtpCapture() {
    const messages: { to: string; raw: string }[] = [];
    const sockets = new Set<Socket>();
    const failures: string[] = [];
    let connections = 0;
    const server = createServer((socket) => {
        sockets.add(socket);
        if (++connections > 64 || sockets.size > 4) {
            failures.push('SMTP_CONNECTION_BOUND');
            socket.destroy();
            return;
        }
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('error', () => failures.push('SMTP_SOCKET_FAILURE'));
        socket.on('close', () => sockets.delete(socket));
        socket.write('220 controlled.example.test ESMTP\r\n');
        let input = '';
        let receivedBytes = 0;
        let recipient = '';
        let data: string[] | undefined;
        let authentication = 0;
        socket.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > 128 * 1024) {
                failures.push('SMTP_MESSAGE_BOUND');
                socket.destroy();
                return;
            }
            input += chunk.toString('utf8');
            let end: number;
            while ((end = input.indexOf('\r\n')) >= 0) {
                const line = input.slice(0, end);
                input = input.slice(end + 2);
                if (data) {
                    if (line !== '.') {
                        data.push(line.startsWith('..') ? line.slice(1) : line);
                        continue;
                    }
                    if (!recipient || messages.length >= 32) {
                        failures.push('SMTP_ENVELOPE_BOUND');
                        socket.destroy();
                        return;
                    }
                    messages.push({ to: recipient, raw: data.join('\r\n') });
                    data = undefined;
                    socket.write('250 Message accepted\r\n');
                } else if (authentication > 0) {
                    const response =
                        --authentication === 0
                            ? '235 Authentication successful\r\n'
                            : '334 UGFzc3dvcmQ6\r\n';
                    socket.write(response);
                } else if (/^(?:EHLO|HELO) /i.test(line)) {
                    socket.write(
                        '250-controlled.example.test\r\n250 AUTH PLAIN LOGIN\r\n'
                    );
                } else if (/^AUTH PLAIN(?: |$)/i.test(line)) {
                    if (line.includes(' ') && line.split(' ').length > 2)
                        socket.write('235 Authentication successful\r\n');
                    else {
                        authentication = 1;
                        socket.write('334 \r\n');
                    }
                } else if (/^AUTH LOGIN/i.test(line)) {
                    authentication = 2;
                    socket.write('334 VXNlcm5hbWU6\r\n');
                } else if (/^MAIL FROM:/i.test(line)) {
                    recipient = '';
                    socket.write('250 Sender accepted\r\n');
                } else if (/^RCPT TO:/i.test(line)) {
                    const address = /<([^>]+)>/.exec(line)?.[1];
                    if (
                        address &&
                        /^[a-z\d._+-]+@example\.test$/i.test(address)
                    ) {
                        recipient = address;
                        socket.write('250 Recipient accepted\r\n');
                    } else {
                        failures.push('SMTP_RECIPIENT_REFUSED');
                        socket.write('550 Controlled recipients only\r\n');
                    }
                } else if (line.toUpperCase() === 'DATA') {
                    data = [];
                    socket.write('354 End with a dot\r\n');
                } else if (line.toUpperCase() === 'QUIT') {
                    socket.end('221 Bye\r\n');
                } else if (/^(?:RSET|NOOP)$/i.test(line)) {
                    socket.write('250 OK\r\n');
                } else {
                    failures.push('SMTP_COMMAND_REFUSED');
                    socket.write('502 Command not supported\r\n');
                }
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
        messages,
        port: address.port,
        assertHealthy() {
            assert.deepEqual(failures, []);
        },
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
        },
    };
}
