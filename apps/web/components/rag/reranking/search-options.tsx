'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckField } from '../form-fields';

export type RerankAvailability =
    'available' | 'loading' | 'error' | 'disabled' | 'denied' | 'notReady';

/** These controls affect one submitted search and never persist a user or collection preference. */
export function RerankSearchOptions({
    availability,
    provider = '',
    model = '',
}: Readonly<{
    availability: RerankAvailability;
    provider?: string;
    model?: string;
}>) {
    const tr = useTranslations('rag.reranking');
    const [enabled, setEnabled] = useState(false);
    const available = availability === 'available';
    return (
        <div className='space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4'>
            <CheckField
                name='rerank'
                label={tr('use')}
                checked={available && enabled}
                disabled={!available}
                onChange={(event) => setEnabled(event.target.checked)}
            />
            <p className='text-xs leading-relaxed text-muted-foreground'>
                {available
                    ? tr('searchHint', {
                          provider,
                          model,
                      })
                    : tr(`availability.${availability}`)}
            </p>
            {available && enabled && (
                <>
                    <p role='status' className='text-sm'>
                        {tr('billable')}
                    </p>
                    <CheckField name='compare' label={tr('compare')} />
                    <p className='text-xs text-muted-foreground'>
                        {tr('compareHint')}
                    </p>
                </>
            )}
        </div>
    );
}
