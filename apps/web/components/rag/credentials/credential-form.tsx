'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
    credentialData,
    credentialUpdateData,
} from '@repo/api-contracts/v1/rag/credentials';
import { provider as credentialProvider } from '@repo/api-contracts/v1/rag/common';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { TextField, SelectField, CheckField } from '../form-fields';
import { CredentialProviderFields } from './credential-provider-fields';
import { credentialFormData } from './credential-form-data';
import type { Credential } from '../types';

export function CredentialForm({
    existing,
    onClose,
}: Readonly<{ existing?: Credential; onClose: () => void }>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const mutation = useCatalogAction();
    const [provider, setProvider] = useState(existing?.provider ?? 'OLLAMA');
    const current = existing?.data;
    return (
        <CatalogDialog
            title={existing ? tr('credentials.edit') : tr('credentials.create')}
            description={tr('credentials.formDescription')}
            busy={mutation.busy}
            onClose={onClose}
        >
            <form
                className='space-y-4'
                onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void mutation.run(async () => {
                        const data = credentialFormData(
                            form,
                            provider,
                            Boolean(existing)
                        );
                        const name = String(form.get('name'));
                        await (existing
                            ? client.admin.rag.credentials.update({
                                  id: existing.id,
                                  expectedRevision: existing.revision,
                                  name,
                                  data: credentialUpdateData.parse(data),
                              })
                            : client.admin.rag.credentials.create({
                                  name,
                                  data: credentialData.parse(data),
                                  activate: form.has('activate'),
                              }));
                    }, onClose);
                }}
            >
                <fieldset disabled={mutation.busy} className='space-y-4'>
                    <TextField
                        label={tr('credentials.name')}
                        name='name'
                        required
                        maxLength={100}
                        defaultValue={existing?.name}
                        autoComplete='off'
                    />
                    <SelectField
                        label={tr('profile.providerLabel')}
                        value={provider}
                        disabled={Boolean(existing)}
                        onChange={(event) => {
                            setProvider(
                                credentialProvider.parse(event.target.value)
                            );
                        }}
                    >
                        <option value='S3'>{tr('credentials.s3')}</option>
                        <option value='OLLAMA'>Ollama</option>
                        <option value='COHERE'>Cohere</option>
                        <option value='VOYAGE'>Voyage</option>
                    </SelectField>
                    <TextField
                        label={tr('credentials.endpoint')}
                        name='endpoint'
                        type='url'
                        required
                        maxLength={2048}
                        defaultValue={current?.endpoint}
                        placeholder='https://service.example.com'
                    />
                    <CredentialProviderFields
                        provider={provider}
                        existing={existing}
                    />
                    {existing ? (
                        <p className='text-sm text-muted-foreground'>
                            {tr('credentials.referencedHint')}
                        </p>
                    ) : (
                        <CheckField
                            name='activate'
                            label={tr('credentials.activate')}
                            defaultChecked
                        />
                    )}
                </fieldset>
                <ActionError error={mutation.error} />
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
