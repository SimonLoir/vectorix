import { runReencryptionCommand } from '@routers/utils/secret-reencryption-command';

// Parsing/help happens before importing any database client. No raw error is logged.
process.exitCode = await runReencryptionCommand(process.argv.slice(2), {
    execute: async (options) => {
        const { prisma } = await import('@repo/db');
        try {
            const { reencryptStoredSecrets } =
                await import('@routers/utils/secret-reencryption');
            return await reencryptStoredSecrets(prisma, options);
        } finally {
            await prisma.$disconnect();
        }
    },
    write: (line) => console.log(line),
    error: (line) => console.error(line),
});
