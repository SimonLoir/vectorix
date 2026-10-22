'use client';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@repo/ui/card';
import { useORPC } from '@/hooks/use-orpc';
import { OrganizationSemanticUsage } from './organization-semantic-usage';
import { toast } from 'sonner';

const fields = [
    { name: 'semanticUnitsPerDocument', min: 1, max: 8192 },
    { name: 'semanticPlanBytesPerDocument', min: 1024, max: 1_048_576 },
    {
        name: 'semanticPlanBytesPerOrganization',
        min: 1024,
        max: Number.MAX_SAFE_INTEGER,
    },
    {
        name: 'embeddingPreparedBytesPerCandidate',
        min: 1024,
        max: Number.MAX_SAFE_INTEGER,
    },
    { name: 'embeddingBatchesPerCandidate', min: 1, max: 4096 },
    {
        name: 'embeddingOutstandingPreparedBytes',
        min: 1024,
        max: Number.MAX_SAFE_INTEGER,
    },
    { name: 'embeddingOutstandingBatches', min: 1, max: 1_000_000 },
] as const;

/** Separate policy form preserves the supported strict six-field RAG quota operation. */
export function OrganizationSemanticQuota({
    organizationId,
}: Readonly<{ organizationId: string }>) {
    const tr = useTranslations('admin.semanticQuota');
    const { orpc } = useORPC();
    const cache = useQueryClient();
    const [invalid, setInvalid] = useState(false);
    const hintId = useId();
    const errorId = useId();
    const query = useQuery({
        ...orpc.superadmin.organizations.getSemanticQuota.queryOptions({
            input: { organizationId },
        }),
        retry: false,
        refetchInterval: 15_000,
    });
    const mutation = useMutation(
        orpc.superadmin.organizations.setSemanticQuota.mutationOptions({
            onSuccess: async () => {
                await cache.invalidateQueries();
                toast.success(tr('saved'));
            },
        })
    );
    if (query.isError)
        return (
            <div role='alert' className='space-y-3 rounded-xl border p-5'>
                <p>{tr('loadFailed')}</p>
                <Button variant='outline' onClick={() => void query.refetch()}>
                    {tr('retry')}
                </Button>
            </div>
        );
    if (query.isPending) return <p role='status'>{tr('loading')}</p>;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{tr('title')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-5'>
                <p className='text-sm text-muted-foreground'>{tr('scope')}</p>
                <p className='text-sm'>
                    {tr(query.data.overridden ? 'overridden' : 'defaults')}
                </p>
                <form
                    key={JSON.stringify(query.data.limits)}
                    className='space-y-5'
                    aria-describedby={hintId}
                    onChange={() => setInvalid(false)}
                    onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        const value = (name: string) => Number(data.get(name));
                        const limits = {
                            semanticUnitsPerDocument: value(
                                'semanticUnitsPerDocument'
                            ),
                            semanticPlanBytesPerDocument: value(
                                'semanticPlanBytesPerDocument'
                            ),
                            semanticPlanBytesPerOrganization: value(
                                'semanticPlanBytesPerOrganization'
                            ),
                            embeddingPreparedBytesPerCandidate: value(
                                'embeddingPreparedBytesPerCandidate'
                            ),
                            embeddingBatchesPerCandidate: value(
                                'embeddingBatchesPerCandidate'
                            ),
                            embeddingOutstandingPreparedBytes: value(
                                'embeddingOutstandingPreparedBytes'
                            ),
                            embeddingOutstandingBatches: value(
                                'embeddingOutstandingBatches'
                            ),
                        };
                        if (
                            fields.some(
                                (field) =>
                                    !Number.isSafeInteger(limits[field.name]) ||
                                    limits[field.name] < field.min ||
                                    limits[field.name] > field.max
                            ) ||
                            limits.semanticPlanBytesPerOrganization <
                                limits.semanticPlanBytesPerDocument ||
                            limits.embeddingOutstandingPreparedBytes <
                                limits.embeddingPreparedBytesPerCandidate ||
                            limits.embeddingOutstandingBatches <
                                limits.embeddingBatchesPerCandidate
                        ) {
                            setInvalid(true);
                            return;
                        }
                        setInvalid(false);
                        mutation.mutate({ organizationId, limits });
                    }}
                >
                    <fieldset
                        disabled={mutation.isPending}
                        className='grid gap-4 sm:grid-cols-2'
                        aria-describedby={invalid ? errorId : hintId}
                    >
                        <legend className='sr-only'>{tr('limitsTitle')}</legend>
                        {fields.map((field) => (
                            <label
                                className='space-y-2 text-sm'
                                key={field.name}
                            >
                                <span>{tr(field.name)}</span>
                                <Input
                                    name={field.name}
                                    type='number'
                                    required
                                    min={field.min}
                                    max={field.max}
                                    step={1}
                                    defaultValue={query.data.limits[field.name]}
                                />
                            </label>
                        ))}
                    </fieldset>
                    <p id={hintId} className='text-sm text-muted-foreground'>
                        {tr('limitsHint')}
                    </p>
                    {invalid && (
                        <p id={errorId} role='alert'>
                            {tr('invalid')}
                        </p>
                    )}
                    {mutation.isError && <p role='alert'>{tr('saveFailed')}</p>}
                    <Button disabled={mutation.isPending}>
                        {tr(mutation.isPending ? 'saving' : 'save')}
                    </Button>
                </form>
                <OrganizationSemanticUsage usage={query.data.usage} />
            </CardContent>
        </Card>
    );
}
