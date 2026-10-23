'use client';

import { useTranslations } from 'next-intl';
import { useIntl } from '@/contexts/intl';
import {
    LanguageSwitcher as LanguageSwitcherBase,
    useLanguagePreference,
} from '@repo/dashboard-core/components/language-switcher';

export function LanguageSwitcher() {
    const t = useTranslations('language');
    const { locale, setLocale } = useIntl();
    const preference = useLanguagePreference(setLocale);

    return (
        <div className='flex max-w-64 flex-col gap-1'>
            <LanguageSwitcherBase
                locale={locale}
                onLocaleChange={preference.onLocaleChange}
                disabled={preference.disabled}
                busy={preference.isSaving}
                languages={[
                    { code: 'en', label: t('en') },
                    { code: 'fr', label: t('fr') },
                    { code: 'nl-BE', label: t('nlBE') },
                ]}
                srLabel={
                    preference.isSaving ? preference.savingLabel : t('label')
                }
            />
            {preference.errorMessage && (
                <p role='alert' className='text-xs text-destructive'>
                    {preference.errorMessage}
                </p>
            )}
        </div>
    );
}
