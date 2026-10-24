import { prisma } from '@repo/db';
import { reencryptStoredSecrets } from '@routers/utils/secret-reencryption';

// Usage: pnpm secrets:reencrypt [--dry-run]. Prints counts only, never values.
const dryRun = process.argv.includes('--dry-run');
try {
    const report = await reencryptStoredSecrets(prisma, { dryRun });
    let failed = 0;
    for (const [column, counts] of Object.entries(report)) {
        failed += counts.failed;
        console.log(
            `${column}: scanned ${counts.scanned}, ${dryRun ? 'would re-encrypt' : 're-encrypted'} ${counts.reencrypted}, failed ${counts.failed}`
        );
    }
    if (failed > 0) process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
