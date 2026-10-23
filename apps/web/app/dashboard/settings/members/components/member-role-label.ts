import { useTranslations } from 'next-intl';

/** Translate built-in display labels while preserving custom role identifiers. */
export function useMemberRoleLabel() {
    const t = useTranslations('members.roleNames');
    return (role: string) => {
        switch (role) {
            case 'owner':
                return t('owner');
            case 'admin':
                return t('admin');
            case 'member':
                return t('member');
            default:
                return role;
        }
    };
}
