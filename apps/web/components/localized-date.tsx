'use client';

import { useLocale } from 'next-intl';

type DateValue = Date | string | number | null | undefined;

type LocalizedDateProps = Readonly<{
    value: DateValue;
    dateStyle?: Intl.DateTimeFormatOptions['dateStyle'];
    timeStyle?: Intl.DateTimeFormatOptions['timeStyle'];
    fallback?: string;
    className?: string;
}>;

function toDate(value: DateValue): Date | null {
    if (value === null || value === undefined) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export default function LocalizedDate({
    value,
    dateStyle = 'medium',
    timeStyle,
    fallback = '—',
    className,
}: LocalizedDateProps) {
    const locale = useLocale();
    const date = toDate(value);

    if (!date) {
        return <span className={className}>{fallback}</span>;
    }

    const formatted = new Intl.DateTimeFormat(locale, {
        dateStyle,
        ...(timeStyle ? { timeStyle } : {}),
    }).format(date);

    return <span className={className}>{formatted}</span>;
}
