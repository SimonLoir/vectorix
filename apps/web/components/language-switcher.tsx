'use client';

import { useTranslations } from 'next-intl';
import { useIntl } from '@/contexts/intl';
import { LanguageSwitcher as LanguageSwitcherBase } from '@repo/dashboard-core/components/language-switcher';

export function LanguageSwitcher() {
    const t = useTranslations('language');
    const { locale, setLocale } = useIntl();

    return (
        <LanguageSwitcherBase
            locale={locale}
            onLocaleChange={(code) => setLocale(code as 'en' | 'fr' | 'nl-BE')}
            languages={[
                { code: 'en', label: t('en') },
                { code: 'fr', label: t('fr') },
                { code: 'nl-BE', label: t('nlBE') },
            ]}
            srLabel={t('label')}
        />
    );
}
