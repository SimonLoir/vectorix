import { prisma, Prisma } from '@repo/db';

const ROLLOUT_ID = 'vectorix-permissions-v1';

/** Initialize the permission policy marker without granting privileges to any existing key. */
export async function initializeVectorixPermissions() {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            return await prisma.$transaction(
                async (tx) => {
                    if (
                        await tx.vectorixAccessControlState.findUnique({
                            where: { id: ROLLOUT_ID },
                        })
                    )
                        return;
                    await tx.vectorixAccessControlState.create({
                        data: { id: ROLLOUT_ID },
                    });
                },
                {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                }
            );
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                ['P2034', 'P2002'].includes(error.code) &&
                attempt < 4
            )
                continue;
            throw error;
        }
    }
}

/** New key issuance is unavailable until the one-time snapshot has completed. */
export async function assertPermissionsInitialized() {
    if (
        !(await prisma.vectorixAccessControlState.findUnique({
            where: { id: ROLLOUT_ID },
        }))
    ) {
        throw new Error('Vectorix permissions have not been initialized.');
    }
}
