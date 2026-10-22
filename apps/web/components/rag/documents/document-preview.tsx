'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { DocumentQueryState } from './query-state';

export function DocumentPreview({ id }: Readonly<{ id: string }>) {
    const tr = useTranslations('rag');
    const { orpc } = useORPC();
    const [pages, setPages] = useState([0]);
    const offset = pages.at(-1)!;
    const query = useQuery(
        orpc.admin.rag.documents.preview.queryOptions({
            retry: false,
            staleTime: 0,
            input: { id, offset },
        })
    );
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h2 className='text-lg font-semibold'>{tr('documents.preview')}</h2>
            <p className='text-sm text-muted-foreground'>
                {tr('documents.previewHint')}
            </p>
            <DocumentQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <pre
                        className='max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm'
                        tabIndex={0}
                        aria-label={tr('documents.preview')}
                    >
                        {query.data.text}
                    </pre>
                    <div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
                        <p>
                            {tr('documents.characters', {
                                from: offset + 1,
                                to: offset + query.data.text.length,
                                total: query.data.totalCharacters,
                            })}
                        </p>
                        <div className='flex gap-2'>
                            <Button
                                variant='outline'
                                disabled={offset === 0}
                                onClick={() =>
                                    setPages((previous) =>
                                        previous.slice(0, -1)
                                    )
                                }
                            >
                                {tr('common.previous')}
                            </Button>
                            <Button
                                variant='outline'
                                disabled={query.data.nextOffset === null}
                                onClick={() =>
                                    query.data?.nextOffset !== null &&
                                    query.data?.nextOffset !== undefined &&
                                    setPages((previous) => [
                                        ...previous,
                                        query.data.nextOffset!,
                                    ])
                                }
                            >
                                {tr('common.next')}
                            </Button>
                        </div>
                    </div>
                </>
            )}
        </section>
    );
}
