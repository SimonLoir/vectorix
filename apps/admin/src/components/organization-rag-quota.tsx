'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@repo/ui/card';
import { toast } from 'sonner';
const fields = [
    { name: 'collections', label: 'Collections', max: 10_000 },
    { name: 'documents', label: 'Documents', max: 10_000_000 },
    {
        name: 'originalBytes',
        label: 'Taille maximale d’un fichier (octets)',
        max: 10_737_418_240,
    },
    {
        name: 'storageBytes',
        label: 'Stockage conservé (octets)',
        max: Number.MAX_SAFE_INTEGER,
    },
    {
        name: 'chunksPerCollection',
        label: 'Passages par collection',
        max: 100_000_000,
    },
] as const;

export function OrganizationRagQuota({
    organizationId,
}: Readonly<{ organizationId: string }>) {
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
                toast.success('Quotas enregistrés');
            },
        })
    );
    if (query.isError)
        return (
            <div role='alert'>
                {query.error.message}{' '}
                <Button variant='outline' onClick={() => void query.refetch()}>
                    Réessayer
                </Button>
            </div>
        );
    if (query.isPending) return <p role='status'>Chargement des quotas…</p>;
    return (
        <Card>
            <CardHeader>
                <CardTitle>Quotas du catalogue RAG</CardTitle>
            </CardHeader>
            <CardContent className='space-y-5'>
                <p className='text-sm text-muted-foreground'>
                    {query.data.overridden
                        ? 'Limites propres à cette organisation.'
                        : 'Valeurs par défaut de la plateforme. Enregistrer crée une dérogation pour cette organisation.'}
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
                                <span>{field.label}</span>
                                <Input
                                    name={field.name}
                                    type='number'
                                    required
                                    min={1}
                                    max={field.max}
                                    step={1}
                                    defaultValue={query.data.limits[field.name]}
                                />
                            </label>
                        ))}
                    </fieldset>
                    <p className='text-sm text-muted-foreground'>
                        1 Mio = 1 048 576 octets. La limite de collections est
                        appliquée dès maintenant. Les limites de stockage et de
                        passages accompagneront l’ingestion. Réduire un quota ne
                        supprime pas les données existantes.
                    </p>
                    {mutation.isError && (
                        <p role='alert'>{mutation.error.message}</p>
                    )}
                    <Button disabled={mutation.isPending}>
                        {mutation.isPending
                            ? 'Enregistrement…'
                            : 'Enregistrer les quotas'}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
