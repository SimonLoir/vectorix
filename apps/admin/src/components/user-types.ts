import type { VectorixApiV1Outputs } from '@repo/api';

export type AdminUser =
    VectorixApiV1Outputs['superadmin']['users']['get']['user'];
export type AdminUserMembership =
    VectorixApiV1Outputs['superadmin']['users']['get']['memberships'][number];
