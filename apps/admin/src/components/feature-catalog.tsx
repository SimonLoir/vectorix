'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers3, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@repo/ui/dialog';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import { Textarea } from '@repo/ui/textarea';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';

const initialForm = {
    key: '',
    name: '',
    description: '',
    category: 'general',
    externalKey: '',
};

export function FeatureCatalog() {
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const [form, setForm] = useState(initialForm);
    const [createOpen, setCreateOpen] = useState(false);
    const [search, setSearch] = useState('');
    const listOptions = orpc.superadmin.features.list.queryOptions({});
    const query = useQuery(listOptions);
    const invalidate = () => queryClient.invalidateQueries(listOptions);
    const createMutation = useMutation(
        orpc.superadmin.features.create.mutationOptions({
            onSuccess: async () => {
                toast.success('Fonctionnalité créée');
                setForm(initialForm);
                setCreateOpen(false);
                await invalidate();
            },
            onError: (error) => toast.error(error.message),
        })
    );
    const updateMutation = useMutation(
        orpc.superadmin.features.update.mutationOptions({
            onSuccess: async () => {
                toast.success('Fonctionnalité mise à jour');
                await invalidate();
            },
            onError: (error) => toast.error(error.message),
        })
    );
    const filteredFeatures = useMemo(() => {
        const term = search.trim().toLowerCase();
        return (query.data?.features ?? []).filter(
            (feature) =>
                !term ||
                feature.name.toLowerCase().includes(term) ||
                feature.key.toLowerCase().includes(term) ||
                feature.category.toLowerCase().includes(term)
        );
    }, [query.data?.features, search]);

    return (
        <div className='space-y-5'>
            <div className='admin-panel flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between'>
                <div className='relative w-full sm:max-w-md'>
                    <Search className='absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400' />
                    <Input
                        className='admin-field border-0 bg-black/20 pl-10 focus-visible:ring-1'
                        value={search}
                        placeholder='Rechercher un module…'
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </div>
                <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                    <DialogTrigger asChild>
                        <Button className='rounded-xl'>
                            <Plus className='h-4 w-4' />
                            Nouvelle fonctionnalité
                        </Button>
                    </DialogTrigger>
                    <DialogContent className='rounded-2xl border-white/10 bg-[#101827] p-0 sm:max-w-2xl'>
                        <DialogHeader className='rounded-t-2xl border-b border-white/8 bg-white/[0.025] px-6 py-5'>
                            <DialogTitle>Nouvelle fonctionnalité</DialogTitle>
                            <DialogDescription>
                                Ajoutez un module au catalogue global Vectorix.
                            </DialogDescription>
                        </DialogHeader>
                        <form
                            className='space-y-5 px-6 pb-6'
                            onSubmit={(event) => {
                                event.preventDefault();
                                createMutation.mutate({
                                    key: form.key,
                                    name: form.name,
                                    description: form.description || null,
                                    category: form.category,
                                    externalKey: form.externalKey || null,
                                    defaultEnabled: false,
                                    isPaywalled: true,
                                    isActive: true,
                                });
                            }}
                        >
                            <div className='grid gap-4 sm:grid-cols-2'>
                                <div className='space-y-2'>
                                    <Label htmlFor='feature-name'>Nom</Label>
                                    <Input
                                        id='feature-name'
                                        className='admin-field'
                                        value={form.name}
                                        required
                                        autoFocus
                                        onChange={(event) =>
                                            setForm((current) => ({
                                                ...current,
                                                name: event.target.value,
                                            }))
                                        }
                                    />
                                </div>
                                <div className='space-y-2'>
                                    <Label htmlFor='feature-key'>
                                        Clé technique
                                    </Label>
                                    <Input
                                        id='feature-key'
                                        className='admin-field font-mono text-sm'
                                        placeholder='reporting.advanced'
                                        value={form.key}
                                        required
                                        onChange={(event) =>
                                            setForm((current) => ({
                                                ...current,
                                                key: event.target.value,
                                            }))
                                        }
                                    />
                                </div>
                                <div className='space-y-2'>
                                    <Label htmlFor='feature-category'>
                                        Catégorie
                                    </Label>
                                    <Input
                                        id='feature-category'
                                        className='admin-field'
                                        value={form.category}
                                        required
                                        onChange={(event) =>
                                            setForm((current) => ({
                                                ...current,
                                                category: event.target.value,
                                            }))
                                        }
                                    />
                                </div>
                                <div className='space-y-2'>
                                    <Label htmlFor='feature-external-key'>
                                        Clé externe
                                    </Label>
                                    <Input
                                        id='feature-external-key'
                                        className='admin-field font-mono text-sm'
                                        placeholder='Optionnelle'
                                        value={form.externalKey}
                                        onChange={(event) =>
                                            setForm((current) => ({
                                                ...current,
                                                externalKey: event.target.value,
                                            }))
                                        }
                                    />
                                </div>
                            </div>
                            <div className='space-y-2'>
                                <Label htmlFor='feature-description'>
                                    Description
                                </Label>
                                <Textarea
                                    id='feature-description'
                                    className='min-h-24 rounded-xl border-white/10 bg-black/15 text-slate-100 shadow-none'
                                    value={form.description}
                                    onChange={(event) =>
                                        setForm((current) => ({
                                            ...current,
                                            description: event.target.value,
                                        }))
                                    }
                                />
                            </div>
                            <p className='text-sm text-slate-400'>
                                Les accès sont définis par les plans du
                                fournisseur externe. Les organisations legacy
                                reçoivent uniquement les fonctionnalités
                                sélectionnées.
                            </p>
                            <DialogFooter>
                                <Button
                                    type='button'
                                    variant='outline'
                                    onClick={() => setCreateOpen(false)}
                                >
                                    Annuler
                                </Button>
                                <Button
                                    type='submit'
                                    disabled={createMutation.isPending}
                                >
                                    {createMutation.isPending
                                        ? 'Création…'
                                        : 'Créer le module'}
                                </Button>
                            </DialogFooter>
                        </form>
                    </DialogContent>
                </Dialog>
            </div>

            {query.isPending ? <LoadingState /> : null}
            {query.isError ? (
                <p className='text-sm text-destructive'>
                    {query.error.message}
                </p>
            ) : null}
            {!query.isPending && filteredFeatures.length === 0 ? (
                <div className='admin-panel grid min-h-64 place-items-center p-8 text-center'>
                    <div>
                        <Layers3 className='mx-auto h-8 w-8 text-slate-300' />
                        <p className='mt-3 font-medium text-slate-300'>
                            Aucun module trouvé
                        </p>
                        <p className='mt-1 text-sm text-slate-400'>
                            Modifiez votre recherche ou créez une
                            fonctionnalité.
                        </p>
                    </div>
                </div>
            ) : null}
            <div className='grid gap-4 xl:grid-cols-2'>
                {filteredFeatures.map((feature) => (
                    <article key={feature.id} className='admin-panel group p-5'>
                        <div className='flex items-start gap-4'>
                            <span
                                className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${
                                    feature.isActive
                                        ? 'bg-indigo-400/10 text-indigo-300'
                                        : 'bg-white/7 text-slate-400'
                                }`}
                            >
                                <Layers3 className='h-5 w-5' />
                            </span>
                            <div className='min-w-0 flex-1'>
                                <div className='flex flex-wrap items-center gap-2'>
                                    <h3 className='font-semibold text-slate-100'>
                                        {feature.name}
                                    </h3>
                                    <Badge variant='secondary'>
                                        {feature.category}
                                    </Badge>
                                    {!feature.isActive && (
                                        <Badge variant='secondary'>
                                            Désactivée globalement
                                        </Badge>
                                    )}
                                </div>
                                <p className='mt-1.5 font-mono text-xs text-indigo-500'>
                                    {feature.key}
                                </p>
                                <p className='mt-3 min-h-10 text-sm leading-5 text-slate-500'>
                                    {feature.description ??
                                        'Aucune description renseignée.'}
                                </p>
                            </div>
                        </div>
                        <div className='mt-5 flex flex-wrap items-center gap-2 border-t border-white/8 pt-4'>
                            <span className='mr-auto text-xs text-slate-400'>
                                Accès via le fournisseur externe ou le statut
                                legacy
                            </span>
                            <Button
                                size='sm'
                                variant='ghost'
                                className={
                                    feature.isActive
                                        ? 'rounded-lg text-xs text-red-300 hover:bg-red-400/10 hover:text-red-200'
                                        : 'rounded-lg text-xs text-emerald-300 hover:bg-emerald-400/10 hover:text-emerald-200'
                                }
                                disabled={updateMutation.isPending}
                                onClick={() =>
                                    updateMutation.mutate({
                                        featureId: feature.id,
                                        isActive: !feature.isActive,
                                    })
                                }
                            >
                                {feature.isActive ? 'Désactiver' : 'Réactiver'}
                            </Button>
                        </div>
                    </article>
                ))}
            </div>
        </div>
    );
}
