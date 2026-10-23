/** Fixed private load paths only; importing never touches the filesystem. */
import fs from 'node:fs';
import path from 'node:path';
import {
    need,
    LoadRuntimeError,
    RUNTIME_LIMITS,
    pathsFor,
    CHILDREN,
    encoded,
} from './load-import-runtime-policy.mjs';
/** Names are fixed capabilities; callers cannot use the file adapter to read other private run material. */
export function createLoadRuntimeFiles(
    directory,
    { privateDirectory, readPrivate, privateCheckpoint }
) {
    privateDirectory(directory);
    const names = new Set([
        'load-baseline-journal.json',
        'load-baseline-report.json',
        ...['pilot', 'full'].flatMap((mode) => Object.values(pathsFor(mode))),
        'load-resource-observations/resources-pilot-summary.json',
        'store-sizes/store-sizes-pilot-before.json',
        'store-sizes/store-sizes-pilot-after.json',
    ]);
    const filename = (relative) => {
        need(names.has(relative), 'LOAD_RUNTIME_PRIVATE');
        const result = path.join(directory, relative);
        privateDirectory(path.dirname(result));
        return result;
    };
    return {
        exists(relative) {
            const file = filename(relative);
            try {
                fs.lstatSync(file);
                return true;
            } catch (error) {
                if (error?.code === 'ENOENT') return false;
                throw new LoadRuntimeError('LOAD_RUNTIME_PRIVATE');
            }
        },
        readJson(relative, maximum) {
            try {
                return JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        readPrivate(filename(relative), maximum)
                    )
                );
            } catch {
                throw new LoadRuntimeError('LOAD_RUNTIME_PRIVATE');
            }
        },
        writeJson(
            relative,
            value,
            exclusive = false,
            maximum = RUNTIME_LIMITS.reportBytes
        ) {
            encoded(value, maximum);
            try {
                privateCheckpoint(filename(relative), value, exclusive);
            } catch {
                throw new LoadRuntimeError('LOAD_RUNTIME_PRIVATE');
            }
        },
        ensureDirectory(name, create) {
            need(CHILDREN.includes(name), 'LOAD_RUNTIME_PRIVATE');
            const child = path.join(directory, name);
            try {
                if (create) fs.mkdirSync(child, { mode: 0o700 });
                privateDirectory(child);
            } catch {
                throw new LoadRuntimeError('LOAD_RUNTIME_PRIOR_PROGRESS');
            }
            return child;
        },
        assertAbsent(relative) {
            need(!this.exists(relative), 'LOAD_RUNTIME_PRIOR_PROGRESS');
            const file = filename(relative) + '.next';
            try {
                fs.lstatSync(file);
                throw new LoadRuntimeError('LOAD_RUNTIME_PRIOR_PROGRESS');
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        },
    };
}
