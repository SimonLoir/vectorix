import type { VectorixApiV1Outputs } from '@repo/api';
type Action =
    VectorixApiV1Outputs['admin']['notifications']['list']['notifications'][number]['action'];
/** Only typed internal destinations may be opened from account notifications. */
export function notificationActionPath(_action: Action) {
    void _action;
    return '/dashboard/account';
}
