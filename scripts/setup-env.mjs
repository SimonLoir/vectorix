import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const example = await readFile(
    new URL('../.env.example', import.meta.url),
    'utf8'
);
const contents = example
    .replace(
        'replace-with-a-random-secret-at-least-32-characters',
        randomBytes(48).toString('base64url')
    )
    .replace(
        'replace-with-64-random-hex-characters',
        randomBytes(32).toString('hex')
    );
try {
    await writeFile(new URL('../.env', import.meta.url), contents, {
        flag: 'wx',
        mode: 0o600,
    });
    console.log(
        'Local .env created with independent authentication and encryption secrets.'
    );
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log('.env already exists; existing settings were preserved.');
}
