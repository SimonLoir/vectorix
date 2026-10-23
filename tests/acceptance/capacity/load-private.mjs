/** Load-only low-level file helpers. Imports perform no filesystem, client or process operation. */
import fs from 'node:fs';
import path from 'node:path';

const need = (value, label) => {
    if (!value) throw new Error(label);
};

/** Locate an existing repository; no helper or runtime is imported as an admission shortcut. */
export function discoverWorkspace(directory) {
    for (let count = 0; count < 7; count++, directory = path.dirname(directory))
        if (
            fs.existsSync(path.join(directory, 'pnpm-workspace.yaml')) &&
            fs.existsSync(
                path.join(directory, 'packages/db/prisma/schema.prisma')
            )
        )
            return directory;
    throw new Error('LOAD_WORKSPACE_NOT_FOUND');
}

/** Require a canonical current-user700 directory before opening private fixture data. */
export function privateDirectory(filename) {
    const value = fs.lstatSync(filename);
    need(
        value.isDirectory() &&
            !value.isSymbolicLink() &&
            value.uid === process.getuid() &&
            (value.mode & 0o777) === 0o700 &&
            fs.realpathSync(filename) === filename,
        'LOAD_PRIVATE_DIRECTORY'
    );
}

/** Read at most the caller's finite cap from a current-user600 regular file without following its leaf. */
export function readPrivate(filename, maximum) {
    need(
        Number.isSafeInteger(maximum) &&
            maximum > 0 &&
            maximum <= 8 * 1024 * 1024,
        'LOAD_PRIVATE_CAP'
    );
    const handle = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const info = fs.fstatSync(handle);
        need(
            info.isFile() &&
                info.uid === process.getuid() &&
                (info.mode & 0o777) === 0o600 &&
                info.size <= maximum,
            'LOAD_PRIVATE_FILE'
        );
        const value = fs.readFileSync(handle);
        need(value.length <= maximum, 'LOAD_PRIVATE_BYTE_CAP');
        return value;
    } finally {
        fs.closeSync(handle);
    }
}

/** Exclusive600 first writes and atomic replacements preserve the synthetic setup journal; no replay is inferred. */
export function privateCheckpoint(filename, value, exclusive = false) {
    privateDirectory(path.dirname(filename));
    const bytes = JSON.stringify(value) + '\n';
    need(Buffer.byteLength(bytes) <= 8 * 1024 * 1024, 'LOAD_CHECKPOINT_CAP');
    const target = exclusive ? filename : filename + '.next';
    const handle = fs.openSync(
        target,
        fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
        0o600
    );
    try {
        fs.writeFileSync(handle, bytes);
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
    if (!exclusive) {
        try {
            const info = fs.lstatSync(filename);
            need(
                info.isFile() &&
                    !info.isSymbolicLink() &&
                    info.uid === process.getuid() &&
                    (info.mode & 0o777) === 0o600,
                'LOAD_CHECKPOINT_EXISTING_FILE'
            );
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        fs.renameSync(target, filename);
    }
    const directory = fs.openSync(
        path.dirname(filename),
        fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW
    );
    try {
        fs.fsyncSync(directory);
    } finally {
        fs.closeSync(directory);
    }
}
