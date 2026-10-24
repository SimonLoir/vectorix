/** Safe metadata-only API-key admission; no native client or I/O on import. */
import { need } from '../s3-outage/private.mjs';
export const READ_PERMISSIONS = Object.freeze({
    ragLibrary: Object.freeze(['read']),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Project only issuer-bound metadata, never native key material, hashes or session tokens. */
export function assessReadKey(key, principals, scopes, audits, fixture, keyId) {
    need(
        key?.id === keyId &&
            key.configId === 'org' &&
            key.referenceId === fixture.organization.id &&
            key.enabled === true &&
            key.vectorixLegacyFullAccess === false &&
            key.expiresAt === null &&
            key.name === `Redis read ${fixture.runId}` &&
            same(JSON.parse(key.permissions ?? 'null'), READ_PERMISSIONS) &&
            principals.length === 1 &&
            scopes === 0 &&
            principals[0].keyId === keyId &&
            principals[0].organizationId === fixture.organization.id &&
            principals[0].memberId === fixture.membershipSnapshot[0].id &&
            audits.length === 1 &&
            audits[0].targetId === keyId &&
            audits[0].organizationId === fixture.organization.id &&
            audits[0].actorId === fixture.users.owner.userId &&
            audits[0].actorType === 'user' &&
            audits[0].action === 'apiKey.create' &&
            audits[0].details?.collectionCount === 0,
        'S3_OUTAGE_TRANSFER_KEY_BINDING'
    );
    return {
        id: keyId,
        name: key.name,
        organizationId: key.referenceId,
        issuerUserId: fixture.users.owner.userId,
        memberId: principals[0].memberId,
        permissions: READ_PERMISSIONS,
        collectionScopes: [],
        auditId: audits[0].id,
    };
}
