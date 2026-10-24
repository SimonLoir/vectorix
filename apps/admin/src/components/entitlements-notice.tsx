'use client';
import { useTranslations } from 'next-intl';

/** States plainly that no route enforces entitlements yet (issue #21). */
export function EntitlementsNotice() {
    const t = useTranslations('admin.secondary.pages');
    return (
        <p
            role='note'
            className='rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100'
        >
            {t('entitlementsInformational')}
        </p>
    );
}
