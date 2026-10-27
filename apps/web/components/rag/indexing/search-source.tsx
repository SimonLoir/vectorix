'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CatalogDialog } from '../catalog-dialog';
import { IndexError, useIndexAction } from './index-state';
import { SearchContext } from './search-context';
import { SearchOriginalSource } from './search-original-source';
import type { SearchResult } from './types';

export type SearchSourceTab = 'context' | 'source';
export type OpenSearchSource = (
    result: SearchResult,
    tab?: SearchSourceTab
) => void;

/** Preserve the ranked receipt while exposing separately reauthorized context and source panels. */
export function SearchSource({
    collectionId,
    result,
    initialTab = 'source',
    onClose,
}: Readonly<{
    collectionId: string;
    result: SearchResult;
    initialTab?: SearchSourceTab;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const [selectedTab, setSelectedTab] = useState(initialTab);
    const canContext =
        canOperation('retrieval.context') && canOperation('retrieval.citation');
    const canSource = canOperation('admin.rag.indexing.sourcePreview');
    const tab =
        !canSource || (canContext && selectedTab === 'context')
            ? 'context'
            : 'source';
    return (
        <CatalogDialog
            title={tr('retrieval.dialogTitle')}
            description={tr('indexing.sourceHint', {
                name: result.documentName,
                version: result.version,
            })}
            onClose={onClose}
            busy={action.busy}
        >
            <IndexError error={action.error} />
            <Tabs
                value={tab}
                onValueChange={(value) => {
                    if (value === 'context' || value === 'source')
                        setSelectedTab(value);
                }}
                className='min-w-0 gap-4'
            >
                <TabsList
                    aria-label={tr('retrieval.tabsLabel')}
                    className='max-w-full'
                >
                    {canContext && (
                        <TabsTrigger value='context'>
                            {tr('retrieval.contextTab')}
                        </TabsTrigger>
                    )}
                    {canSource && (
                        <TabsTrigger value='source'>
                            {tr('retrieval.sourceTab')}
                        </TabsTrigger>
                    )}
                </TabsList>
                {canContext && (
                    <TabsContent
                        value='context'
                        forceMount
                        hidden={tab !== 'context'}
                        className='min-w-0'
                    >
                        <SearchContext
                            collectionId={collectionId}
                            result={result}
                            active={tab === 'context'}
                        />
                    </TabsContent>
                )}
                {canSource && (
                    <TabsContent
                        value='source'
                        forceMount
                        hidden={tab !== 'source'}
                        className='min-w-0'
                    >
                        <SearchOriginalSource
                            collectionId={collectionId}
                            result={result}
                            active={tab === 'source'}
                            action={action}
                        />
                    </TabsContent>
                )}
            </Tabs>
        </CatalogDialog>
    );
}
