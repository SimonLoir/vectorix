import { prisma } from '@repo/db';
const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error('Usage: pnpm admin:grant user@example.com');
try {
    await prisma.user.update({
        where: { email },
        data: { isSuperAdmin: true },
    });
    console.log('Administrator access granted.');
} finally {
    await prisma.$disconnect();
}
