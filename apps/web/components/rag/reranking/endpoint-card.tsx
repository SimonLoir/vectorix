'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { Badge } from '@repo/ui/badge';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import type { RerankEndpoint } from './types';

export function RerankEndpointCard({
    item,
    onEdit,
    onActivate,
    onRemove,
}: Readonly<{
    item: RerankEndpoint;
    onEdit: () => void;
    onActivate: () => void;
    onRemove: () => void;
}>) {
    const tr = useTranslations('rag.reranking.endpoints');
    const rag = useTranslations('rag');
    const { canOperation } = useVectorixPermissions();
    return (
        <article className='space-y-4 rounded-xl border bg-card p-5'>
            <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                    <h3 className='break-words font-semibold'>{item.name}</h3>
                    <p className='mt-1 text-sm text-muted-foreground'>
                        {rag('credentials.revision', {
                            provider: item.provider,
                            revision: item.revision,
                        })}
                    </p>
                </div>
                <Badge variant={item.active ? 'default' : 'secondary'}>
                    {rag(
                        item.active
                            ? 'credentials.selected'
                            : 'credentials.notSelected'
                    )}
                </Badge>
            </div>
            <p className='break-all text-sm'>{item.endpoint}</p>
            <p className='text-xs text-muted-foreground'>
                {tr(item.apiKey === null ? 'noKey' : 'maskedKey')}
            </p>
            <div className='flex flex-wrap gap-2'>
                {canOperation('admin.rag.reranking.endpoints.update') && (
                    <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        onClick={onEdit}
                    >
                        {tr('editAction')}
                    </Button>
                )}
                {!item.active &&
                    canOperation('admin.rag.reranking.endpoints.activate') && (
                        <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            onClick={onActivate}
                        >
                            {rag('credentials.select')}
                        </Button>
                    )}
                {canOperation('admin.rag.reranking.endpoints.remove') && (
                    <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        onClick={onRemove}
                    >
                        {rag('common.delete')}
                    </Button>
                )}
            </div>
        </article>
    );
}
