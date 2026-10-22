'use client';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { CatalogDialog } from '../catalog-dialog';
import { IndexError, useIndexAction } from '../indexing/index-state';
import { TextField, AreaField, CheckField } from '../form-fields';
import { ProfileFields } from './profile-fields';
import { ProfileSummary } from './profile-summary';
import type { Collection } from '../types';

export function CollectionForm({
    existing,
    profileLocked = false,
    onClose,
}: Readonly<{
    existing?: Collection;
    profileLocked?: boolean;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const router = useRouter();
    const mutation = useIndexAction();
    return (
        <CatalogDialog
            title={existing ? tr('collections.edit') : tr('collections.create')}
            description={tr('collections.formDescription')}
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
                            if (
                                !(profileLocked && existing) &&
                                data.get('metadataFieldsValid') !== 'true'
                            )
                                throw new Error(tr('indexing.invalidFields'));
                            const number = (key: string) =>
                                Number(data.get(key));
                            const profile =
                                profileLocked && existing
                                    ? collectionProfile
                                          .strip()
                                          .parse(existing.configuration)
                                    : collectionProfile.parse({
                                          provider: data.get('provider'),
                                          model: data.get('model'),
                                          dimensions: number('dimensions'),
                                          indexType: data.get('indexType'),
                                          preparation: data.get('preparation'),
                                          embeddingPreset:
                                              data.get('embeddingPreset'),
                                          metadataFields: JSON.parse(
                                              String(
                                                  data.get('metadataFields') ??
                                                      '{}'
                                              )
                                          ) as unknown,
                                          chunkingStrategy:
                                              data.get('chunkingStrategy'),
                                          parentChild: data.has('parentChild'),
                                          chunking: {
                                              targetTokens:
                                                  number('targetTokens'),
                                              overlapTokens:
                                                  number('overlapTokens'),
                                              minTokens: number('minTokens'),
                                              maxTokens: number('maxTokens'),
                                              semanticPercentile:
                                                  number('semanticPercentile'),
                                              parentMaxTokens:
                                                  number('parentMaxTokens'),
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
                        label={tr('collections.name')}
                        name='name'
                        required
                        maxLength={200}
                        defaultValue={existing?.name}
                    />
                    <AreaField
                        label={tr('common.description')}
                        name='description'
                        maxLength={2000}
                        defaultValue={existing?.description ?? ''}
                        rows={2}
                    />
                    {profileLocked && existing ? (
                        <section className='space-y-4 rounded-lg border p-4'>
                            <p role='status' className='text-sm'>
                                {tr('indexing.rebuild.profileLocked')}
                            </p>
                            <ProfileSummary
                                configuration={existing.configuration}
                            />
                        </section>
                    ) : (
                        <ProfileFields
                            configuration={existing?.configuration}
                            collectionId={existing?.id}
                            configurationRevision={
                                existing?.configurationRevision
                            }
                        />
                    )}
                    {!existing && (
                        <CheckField
                            name='grantCreatorRead'
                            label={tr('collections.grantSelf')}
                            defaultChecked
                        />
                    )}
                    <p className='text-sm text-muted-foreground'>
                        {tr('collections.bindingHint')}
                    </p>
                </fieldset>
                <IndexError error={mutation.error} />
                <div className='flex justify-end gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={mutation.busy}
                        onClick={onClose}
                    >
                        {tr('common.cancel')}
                    </Button>
                    <Button disabled={mutation.busy}>
                        {mutation.busy
                            ? tr('common.saving')
                            : tr('common.save')}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
