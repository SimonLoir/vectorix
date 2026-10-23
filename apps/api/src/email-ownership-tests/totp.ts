import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

/** RFC 6238 computation from the normal enable response, not a bypass of 2FA. */
export function totp(secret: string) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...secret.replaceAll('=', '').toUpperCase()]
        .map((character) => {
            const index = alphabet.indexOf(character);
            assert.ok(index !== -1);
            return index.toString(2).padStart(5, '0');
        })
        .join('');
    const key = Buffer.from(
        (bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2))
    );
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const digest = createHmac('sha1', key).update(counter).digest();
    const offset = digest.at(-1)! & 0xf;
    return ((digest.readUInt32BE(offset) & 0x7f_ff_ff_ff) % 1_000_000)
        .toString()
        .padStart(6, '0');
}
