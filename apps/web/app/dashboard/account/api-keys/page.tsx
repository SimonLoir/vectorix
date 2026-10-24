'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import DashboardPage from '@/components/dashboard-page';
import PageTitle from '@repo/dashboard-core/components/page-title';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import {
    Table,
    TableBody,
    TableHead,
    TableHeader,
    TableRow,
} from '@repo/ui/table';
import { CopyToClipboardButton } from '@repo/dashboard-core/components/copy-to-clipboard-button';
import PaddedSpinner from '@repo/dashboard-core/components/padded-spinner';
import { CopyIcon } from 'lucide-react';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { ApiKeyPermissionsDialog } from './components/api-key-permissions-dialog';
import ApiKeyLine from './components/api-key-line';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';
import { RequestErrorState } from '@/components/request-error-state';
import {
    CatalogPagination,
    CatalogSearch,
    useCatalogPagination,
} from '@/components/rag/catalog-controls';

/** Lists legacy/scoped keys without rotating or changing existing production secrets. */
export default function APIKeysPage() {
    const { orpc } = useORPC();
    const { can } = useVectorixPermissions();
    const t = useTranslations('apiKeys');
    const [creating, setCreating] = useState(false);
    const [newKey, setNewKey] = useState<string | null>(null);
    const page = useCatalogPagination();
    const query = useQuery(
        orpc.admin.organization.apiKeys.list.queryOptions({
            input: {
                offset: page.offset,
                limit: page.limit,
                query: page.query,
            },
        })
    );
    if (query.isPending && !page.query && page.offset === 0)
        return <PaddedSpinner />;
    if (query.isError)
        return (
            <DashboardPage className='space-y-6'>
                <PageTitle>{t('title')}</PageTitle>
                <RequestErrorState
                    errorKey={requestErrorKey(query.error)}
                    onRetry={query.refetch}
                />
            </DashboardPage>
        );
    return (
        <DashboardPage className='space-y-6'>
            <div className='flex items-center justify-between'>
                <PageTitle>{t('title')}</PageTitle>
                {can({ apiKey: ['create'] }) && (
                    <Button onClick={() => setCreating(true)}>
                        {t('getNewKey')}
                    </Button>
                )}
            </div>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={t('search')}
            />
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t('name')}</TableHead>
                        <TableHead>{t('created')}</TableHead>
                        <TableHead>{t('expires')}</TableHead>
                        <TableHead>Permissions</TableHead>
                        <TableHead>{t('actions')}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {query.data?.keys.map((key) => (
                        <ApiKeyLine key={key.id} apiKey={key} />
                    ))}
                </TableBody>
            </Table>
            {query.data && (
                <CatalogPagination
                    offset={page.offset}
                    total={query.data.total}
                    limit={page.limit}
                    onChange={page.setOffset}
                />
            )}
            {creating && (
                <ApiKeyPermissionsDialog
                    onClose={() => setCreating(false)}
                    onCreated={setNewKey}
                />
            )}
            <Dialog
                open={Boolean(newKey)}
                onOpenChange={(open) => {
                    if (!open) setNewKey(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('newKeyTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('newKeyDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    <div className='flex gap-2'>
                        <Input readOnly value={newKey ?? ''} />
                        <CopyToClipboardButton copyText={newKey ?? ''}>
                            <CopyIcon />
                        </CopyToClipboardButton>
                    </div>
                </DialogContent>
            </Dialog>
        </DashboardPage>
    );
}
