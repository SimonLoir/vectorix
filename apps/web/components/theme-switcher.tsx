'use client';

import { useTranslations } from 'next-intl';
import { ThemeSwitcher as SharedThemeSwitcher } from '@repo/dashboard-core/components/theme-switcher';

/** Browser-local appearance preference; no account or organization mutation. */
export function ThemeSwitcher() {
    const tr = useTranslations('appearance');
    return (
        <SharedThemeSwitcher
            labels={{
                appearance: tr('label'),
                light: tr('light'),
                dark: tr('dark'),
                system: tr('system'),
            }}
        />
    );
}
