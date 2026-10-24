import type { ReencryptionReport } from './secret-reencryption';

export type ReencryptionCommand = 'HELP' | Readonly<{ dryRun: boolean }>;

/** Unknown or repeated flags never fall through into a mutating command. */
export function parseReencryptionArguments(
    args: readonly string[]
): ReencryptionCommand {
    if (args.length === 0) return { dryRun: false };
    if (args.length === 1 && args[0] === '--dry-run') return { dryRun: true };
    if (args.length === 1 && args[0] === '--help') return 'HELP';
    throw new Error('Usage: pnpm secrets:reencrypt [--dry-run | --help]');
}

/** Print only fixed column names and numeric counters; never stringify caught errors. */
export async function runReencryptionCommand(
    args: readonly string[],
    dependencies: Readonly<{
        execute: (options: { dryRun: boolean }) => Promise<ReencryptionReport>;
        write: (line: string) => void;
        error: (line: string) => void;
    }>
): Promise<number> {
    try {
        const command = parseReencryptionArguments(args);
        if (command === 'HELP') {
            dependencies.write(
                'Usage: pnpm secrets:reencrypt [--dry-run | --help]'
            );
            return 0;
        }
        const report = await dependencies.execute(command);
        for (const [column, counts] of Object.entries(report.columns)) {
            dependencies.write(
                `${column}: scanned ${counts.scanned}, authenticated ${counts.authenticated}, re-encrypted ${counts.reencrypted}, would re-encrypt ${counts.wouldReencrypt}, conflicts ${counts.conflicts}, failed ${counts.failed}, remaining ${counts.remaining}, verification failed ${counts.verificationFailed}`
            );
        }
        dependencies.write(`Re-encryption status: ${report.status}`);
        dependencies.write(
            'Key retirement additionally requires all writers to use the current key and no concurrent writes during verification.'
        );
        return report.status === 'INCOMPLETE' ? 1 : 0;
    } catch {
        dependencies.error(
            'Secret re-encryption failed. Check configuration and database availability; no completion is established.'
        );
        return 1;
    }
}
