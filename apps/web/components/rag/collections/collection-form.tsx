'use client';
import { useRouter } from 'next/navigation';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { TextField, AreaField, CheckField } from '../form-fields';
import { ProfileFields } from './profile-fields';
import type { Collection } from '../types';

export function CollectionForm({
    existing,
    onClose,
}: Readonly<{ existing?: Collection; onClose: () => void }>) {
    const { client } = useORPC();
    const router = useRouter();
    const mutation = useCatalogAction();
    return (
        <CatalogDialog
            title={existing ? 'Modifier la collection' : 'Créer une collection'}
            description='Enregistrez un profil de configuration. Les documents, l’indexation et la recherche seront disponibles dans les prochaines étapes.'
            busy={mutation.busy}
            onClose={onClose}
        >
            <form
                className='space-y-5'
                onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    let savedId: string | undefined;
                    void mutation.run(
                        async () => {
                            const number = (key: string) =>
                                Number(data.get(key));
                            const profile = collectionProfile.parse({
                                provider: data.get('provider'),
                                model: data.get('model'),
                                dimensions: number('dimensions'),
                                indexType: data.get('indexType'),
                                preparation: data.get('preparation'),
                                chunkingStrategy: data.get('chunkingStrategy'),
                                parentChild: data.has('parentChild'),
                                chunking: {
                                    targetTokens: number('targetTokens'),
                                    overlapTokens: number('overlapTokens'),
                                    minTokens: number('minTokens'),
                                    maxTokens: number('maxTokens'),
                                    semanticPercentile:
                                        number('semanticPercentile'),
                                    parentMaxTokens: number('parentMaxTokens'),
                                },
                            });
                            const input = {
                                name: String(data.get('name')),
                                description: String(data.get('description')),
                                profile,
                            };
                            const result = existing
                                ? await client.admin.rag.collections.update({
                                      ...input,
                                      id: existing.id,
                                      expectedRevision:
                                          existing.configurationRevision,
                                  })
                                : await client.admin.rag.collections.create({
                                      ...input,
                                      grantCreatorRead:
                                          data.has('grantCreatorRead'),
                                  });
                            savedId = result.id;
                        },
                        () => {
                            onClose();
                            if (!existing && savedId)
                                router.push(
                                    `/dashboard/collections/${savedId}`
                                );
                        }
                    );
                }}
            >
                <fieldset disabled={mutation.busy} className='space-y-5'>
                    <TextField
                        label='Nom de la collection'
                        name='name'
                        required
                        maxLength={200}
                        defaultValue={existing?.name}
                    />
                    <AreaField
                        label='Description'
                        name='description'
                        maxLength={2000}
                        defaultValue={existing?.description ?? ''}
                        rows={2}
                    />
                    <ProfileFields configuration={existing?.configuration} />
                    {!existing && (
                        <CheckField
                            name='grantCreatorRead'
                            label='M’accorder explicitement la lecture de cette collection'
                            defaultChecked
                        />
                    )}
                    <p className='text-sm text-muted-foreground'>
                        Le profil utilise les credentials sélectionnés pour ce
                        fournisseur, ou ceux de la plateforme en l’absence de
                        configuration dans l’organisation. Enregistrer une
                        modification crée une nouvelle révision.
                    </p>
                </fieldset>
                <ActionError error={mutation.error} />
                <div className='flex justify-end gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={mutation.busy}
                        onClick={onClose}
                    >
                        Annuler
                    </Button>
                    <Button disabled={mutation.busy}>
                        {mutation.busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
