'use client';
import { useTranslations } from 'next-intl';
import { Badge } from '@repo/ui/badge';

export function StatusBadge({ active }: { readonly active: boolean }) {
    const tr = useTranslations('admin.core');
    return (
        <Badge
            variant='outline'
            className={
                active
                    ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                    : 'border-white/10 bg-white/5 text-slate-400'
            }
        >
            <span
                className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-slate-400'}`}
            />
            {tr(active ? 'activeStatus' : 'inactiveStatus')}
        </Badge>
    );
}
