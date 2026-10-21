'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { LanguageSwitcher as BaseLanguageSwitcher } from '@repo/dashboard-core/components/language-switcher';
import { setAdminLocale } from '@/i18n/actions';

export function LanguageSwitcher() {
    const locale = useLocale();
    const t = useTranslations('language');
    const router = useRouter();
    return (
        <BaseLanguageSwitcher
            locale={locale}
            srLabel={t('label')}
            languages={[
                { code: 'en', label: t('en') },
                { code: 'fr', label: t('fr') },
                { code: 'nl-BE', label: t('nlBE') },
            ]}
            onLocaleChange={async (value) => {
                await setAdminLocale(value);
                router.refresh();
            }}
        />
    );
}
