'use client';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@repo/ui/card';
import { toast } from 'sonner';
const fields = [
    { name: 'collections', label: 'quota.collections', max: 10_000 },
    { name: 'documents', label: 'quota.documents', max: 10_000_000 },
    {
        name: 'originalBytes',
        label: 'quota.originalBytes',
        max: 10_737_418_240,
    },
    {
        name: 'storageBytes',
        label: 'quota.storageBytes',
        max: Number.MAX_SAFE_INTEGER,
    },
    {
        name: 'temporaryChunksPerCollection',
        label: 'quota.temporaryChunksPerCollection',
        max: 100_000_000,
    },
    {
        name: 'chunksPerCollection',
        label: 'quota.chunksPerCollection',
        max: 100_000_000,
    },
] as const;

export function OrganizationRagQuota({
    organizationId,
}: Readonly<{ organizationId: string }>) {
    const tr = useTranslations('admin');
    const { orpc } = useORPC();
    const cache = useQueryClient();
    const query = useQuery(
        orpc.superadmin.organizations.getRagQuota.queryOptions({
            input: { organizationId },
        })
    );
    const mutation = useMutation(
        orpc.superadmin.organizations.setRagQuota.mutationOptions({
            onSuccess: async () => {
                await cache.invalidateQueries();
                toast.success(tr('quota.saved'));
            },
        })
    );
    if (query.isError)
        return (
            <div role='alert'>
                {tr('quota.loadFailed')}{' '}
                <Button variant='outline' onClick={() => void query.refetch()}>
                    {tr('quota.retry')}
                </Button>
            </div>
        );
    if (query.isPending) return <p role='status'>{tr('quota.loading')}</p>;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{tr('quota.title')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-5'>
                <p className='text-sm text-muted-foreground'>
                    {query.data.overridden
                        ? tr('quota.overridden')
                        : tr('quota.defaults')}
                </p>
                <form
                    className='space-y-5'
                    key={JSON.stringify(query.data)}
                    onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        const number = (name: string) => Number(form.get(name));
                        mutation.mutate({
                            organizationId,
                            limits: {
                                collections: number('collections'),
                                documents: number('documents'),
                                originalBytes: number('originalBytes'),
                                storageBytes: number('storageBytes'),
                                temporaryChunksPerCollection: number(
                                    'temporaryChunksPerCollection'
                                ),
                                chunksPerCollection: number(
                                    'chunksPerCollection'
                                ),
                            },
                        });
                    }}
                >
                    <fieldset
                        disabled={mutation.isPending}
                        className='grid gap-4 sm:grid-cols-2'
                    >
                        {fields.map((field) => (
                            <label
                                className='space-y-2 text-sm'
                                key={field.name}
                            >
                                <span>{tr(field.label)}</span>
                                <Input
                                    name={field.name}
                                    type='number'
                                    required
                                    min={
                                        field.name ===
                                        'temporaryChunksPerCollection'
                                            ? 0
                                            : 1
                                    }
                                    max={field.max}
                                    step={1}
                                    defaultValue={query.data.limits[field.name]}
                                />
                            </label>
                        ))}
                    </fieldset>
                    <p className='text-sm text-muted-foreground'>
                        {tr('quota.hint')}
                    </p>
                    {mutation.isError && (
                        <p role='alert'>{tr('quota.saveFailed')}</p>
                    )}
                    <Button disabled={mutation.isPending}>
                        {mutation.isPending
                            ? tr('quota.saving')
                            : tr('quota.save')}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
