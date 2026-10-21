/** Session fields passed to sign-in listeners once Better Auth has stored it. */
export type CreatedSession = Readonly<{
    id: string;
    userId: string;
    createdAt: Date;
    activeOrganizationId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
}>;

type SessionCreatedListener = (session: CreatedSession) => Promise<void>;

const listeners: SessionCreatedListener[] = [];

/**
 * Registers a callback run after every new session (password, passkey, CLI
 * device approval…). The API registers its notification producer here so
 * `@repo/auth` keeps no dependency on the router packages.
 */
export function onSessionCreated(listener: SessionCreatedListener) {
    listeners.push(listener);
}

/**
 * Runs listeners without ever failing sign-in: errors go to `onError` and
 * the session stays valid.
 */
export async function notifySessionCreated(
    session: CreatedSession,
    onError: (error: unknown) => void = (error) =>
        console.warn('Session-created listener failed', error)
) {
    await Promise.all(
        listeners.map((listener) => listener(session).catch(onError))
    );
}
