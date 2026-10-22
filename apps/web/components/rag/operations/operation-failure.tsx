'use client';
import { useTranslations } from 'next-intl';
import type { OperationItem } from './types';

/** Stored/provider strings are never rendered; only complete, known localized diagnostics are shown. */
export function OperationFailure({ item }: Readonly<{ item: OperationItem }>) {
    const tr = useTranslations('rag');
    if (!item.errorCode) return null;
    const prefixes =
        item.category === 'INDEXING'
            ? ['indexing.errors']
            : [
                  'documents.errors',
                  'documents.diagnostics',
                  'operations.errors',
              ];
    const key = /^[A-Z_]{1,64}$/u.test(item.errorCode)
        ? prefixes
              .map((prefix) => `${prefix}.${item.errorCode}`)
              .find((candidate) => tr.has(candidate))
        : undefined;
    return (
        <p className='text-sm text-destructive'>
            {key ? tr(key) : tr('operations.unknownFailure')}
        </p>
    );
}
