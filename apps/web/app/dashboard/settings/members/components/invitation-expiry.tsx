'use client';

import { useFormatter, useNow, useTranslations } from 'next-intl';

/** Both values use the saved expiry and the provider's validated runtime timezone. */
export function InvitationExpiry({
    expiresAt,
}: Readonly<{ expiresAt: Date | string }>) {
    const format = useFormatter();
    const now = useNow({ updateInterval: 60_000 });
    const t = useTranslations('members');
    const date = new Date(expiresAt);
    if (!Number.isFinite(date.getTime()))
        return <span>{t('expiryUnavailable')}</span>;
    return (
        <div className='space-y-1 text-sm'>
            <time dateTime={date.toISOString()}>
                {format.dateTime(date, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                })}
            </time>
            <p className='text-muted-foreground'>
                {t(date <= now ? 'expiredRelative' : 'expiresRelative', {
                    relative: format.relativeTime(date, now),
                })}
            </p>
        </div>
    );
}
