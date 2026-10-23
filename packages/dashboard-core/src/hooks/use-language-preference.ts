'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { supportedLocales, type Locale } from '../i18n/locale';
import { useAuth } from './use-auth';

type PreferenceError = 'saveFailed' | 'sessionRequired' | 'displayFailed';

function preferenceError(error: unknown): PreferenceError {
    if (error && typeof error === 'object' && 'code' in error) {
        switch (error.code) {
            case 'USER_LOCALE_SESSION_REQUIRED':
            case 'UNAUTHORIZED':
            case 'SESSION_EXPIRED':
                return 'sessionRequired';
        }
    }
    return 'saveFailed';
}

/**
 * Only an explicit choice writes a preference. Authenticated native writes must
 * succeed before the app changes its display cookie; server rejection never
 * falls back to a local-only change. A null session changes display only, even
 * when auth is unavailable. Session refreshes do not trigger writes.
 */
export function useLanguagePreference(
    applyLocale: (locale: Locale) => Promise<void>
) {
    const auth = useAuth();
    const {
        data: session,
        isPending,
        isRefetching,
        refetch,
    } = auth.useSession();
    const t = useTranslations('languagePreference');
    const saving = useRef(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<PreferenceError | null>(null);

    const onLocaleChange = async (value: string) => {
        if (saving.current || isPending || isRefetching) return;
        const locale = supportedLocales.find((entry) => entry === value);
        if (!locale) {
            setError('saveFailed');
            return;
        }
        saving.current = true;
        setIsSaving(true);
        setError(null);
        let displayPhase = false;
        try {
            if (session?.user) {
                const result = await auth.updateUser({ locale });
                if (result.error) {
                    setError(preferenceError(result.error));
                    return;
                }
                if (!result.data?.status) {
                    setError('saveFailed');
                    return;
                }
                await refetch();
            }
            displayPhase = true;
            await applyLocale(locale);
        } catch {
            setError(displayPhase ? 'displayFailed' : 'saveFailed');
        } finally {
            saving.current = false;
            setIsSaving(false);
        }
    };

    return {
        onLocaleChange,
        disabled: isPending || isRefetching || isSaving,
        isSaving,
        errorMessage: error ? t(error) : null,
        savingLabel: t('saving'),
    };
}
