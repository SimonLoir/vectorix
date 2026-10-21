'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@repo/ui/card';
import { OrganizationLegacyAccess } from './organization-legacy-access';
import { toast } from 'sonner';
export function OrganizationSummary({
    organizationId,
}: {
    readonly organizationId: string;
}) {
    const { orpc } = useORPC();
    const cache = useQueryClient();
    const query = useQuery(
        orpc.superadmin.organizations.get.queryOptions({
            input: { organizationId },
        })
    );
    const mutation = useMutation(
        orpc.superadmin.organizations.update.mutationOptions({
            onSuccess: async () => {
                await cache.invalidateQueries();
                toast.success('Organisation enregistrée');
            },
            onError: (error) => toast.error(error.message),
        })
    );
    if (query.isPending) return <p>Chargement…</p>;
    if (query.isError) return <p role='alert'>{query.error.message}</p>;
    const organization = query.data;
    return (
        <div className='space-y-6'>
            <Card>
                <CardHeader>
                    <CardTitle>{organization.name}</CardTitle>
                </CardHeader>
                <CardContent>
                    <form
                        className='space-y-4'
                        key={organization.name + organization.slug}
                        onSubmit={(event) => {
                            event.preventDefault();
                            const data = new FormData(event.currentTarget);
                            mutation.mutate({
                                organizationId,
                                name: String(data.get('name')),
                                slug: String(data.get('slug')),
                                isActive: data.get('active') === 'on',
                            });
                        }}
                    >
                        <label className='block'>
                            Nom
                            <Input
                                name='name'
                                required
                                defaultValue={organization.name}
                            />
                        </label>
                        <label className='block'>
                            Identifiant
                            <Input
                                name='slug'
                                required
                                defaultValue={organization.slug}
                            />
                        </label>
                        <label className='flex gap-2'>
                            <input
                                name='active'
                                type='checkbox'
                                defaultChecked={organization.isActive}
                            />
                            Organisation active
                        </label>
                        <Button disabled={mutation.isPending}>
                            Enregistrer
                        </Button>
                    </form>
                </CardContent>
            </Card>
            <OrganizationLegacyAccess
                organizationId={organizationId}
                enabled={organization.vectorixLegacyAccess ?? false}
            />
        </div>
    );
}
