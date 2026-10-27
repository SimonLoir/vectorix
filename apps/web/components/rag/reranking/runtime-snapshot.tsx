'use client';
import { useFormatter, useTranslations } from 'next-intl';
import type { RerankRuntimeSnapshot } from './types';

/** Reported metadata is a saved runtime declaration, never a verified weight digest. */
export function RuntimeSnapshot({
    snapshot,
}: Readonly<{ snapshot: RerankRuntimeSnapshot }>) {
    const tr = useTranslations('rag.reranking.runtime');
    const common = useTranslations('rag.reranking');
    const format = useFormatter();
    const facts = [
        { key: 'model', value: snapshot.modelId },
        { key: 'revision', value: snapshot.modelRevision ?? common('unknown') },
        { key: 'modelType', value: snapshot.modelType },
        { key: 'version', value: snapshot.runtimeVersion },
        { key: 'dtype', value: snapshot.modelDtype },
        { key: 'inputLimit', value: format.number(snapshot.maxInputLength) },
        {
            key: 'batchLimit',
            value: format.number(snapshot.maxClientBatchSize),
        },
        { key: 'protocol', value: snapshot.protocolVersion },
    ] as const;
    return (
        <details className='rounded-lg border bg-muted/20 p-3'>
            <summary className='cursor-pointer text-sm font-medium'>
                {tr('title')}
            </summary>
            <p className='mt-3 text-xs text-muted-foreground'>{tr('hint')}</p>
            <dl className='mt-3 grid gap-3 sm:grid-cols-2'>
                {facts.map(({ key, value }) => (
                    <div key={key} className='min-w-0 text-sm'>
                        <dt className='text-muted-foreground'>{tr(key)}</dt>
                        <dd className='mt-1 break-words font-medium'>
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
        </details>
    );
}
