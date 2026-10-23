'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
    LanguageSwitcher as BaseLanguageSwitcher,
    useLanguagePreference,
} from '@repo/dashboard-core/components/language-switcher';
import { setAdminLocale } from '@/i18n/actions';

export function LanguageSwitcher() {
    const locale = useLocale();
    const t = useTranslations('language');
    const router = useRouter();
    const preference = useLanguagePreference(async (value) => {
        await setAdminLocale(value);
        router.refresh();
    });
    return (
        <div className='flex max-w-64 flex-col gap-1'>
            <BaseLanguageSwitcher
                locale={locale}
                srLabel={
                    preference.isSaving ? preference.savingLabel : t('label')
                }
                disabled={preference.disabled}
                busy={preference.isSaving}
                languages={[
                    { code: 'en', label: t('en') },
                    { code: 'fr', label: t('fr') },
                    { code: 'nl-BE', label: t('nlBE') },
                ]}
                onLocaleChange={preference.onLocaleChange}
            />
            {preference.errorMessage && (
                <p role='alert' className='text-xs text-destructive'>
                    {preference.errorMessage}
                </p>
            )}
        </div>
    );
}
