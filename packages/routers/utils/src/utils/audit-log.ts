type AuditActorContext = Readonly<{
    user?: Readonly<{ id: string }> | null;
    key?: Readonly<{ id: string }> | null;
}>;

/** Returns stable, non-secret actor fields for security and audit logs. */
export function getAuditActorFields(context: AuditActorContext): {
    actorType: 'user' | 'api-key' | 'unknown';
    actorId?: string;
} {
    if (context.user) {
        return { actorType: 'user', actorId: context.user.id };
    }
    if (context.key) {
        return { actorType: 'api-key', actorId: context.key.id };
    }
    return { actorType: 'unknown' };
}
