'use client';
import { useTranslations } from 'next-intl';
import {
    documentMetadata,
    documentTags,
} from '@repo/api-contracts/v1/rag/indexing-types';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { TextField, SelectField } from '../form-fields';
import { IndexError, useIndexAction } from './index-state';
import type { IndexDocument, MetadataFields } from './types';

export function typedMetadataValue(
    value: string,
    type: MetadataFields[string]
) {
    switch (type) {
        case 'NUMBER': {
            const number = Number(value);
            if (!Number.isFinite(number)) throw new Error('Invalid metadata.');
            return number;
        }
        case 'BOOLEAN':
            if (value !== 'true' && value !== 'false')
                throw new Error('Invalid metadata.');
            return value === 'true';
        case 'DATE': {
            const date = new Date(value);
            if (!Number.isFinite(date.getTime()))
                throw new Error('Invalid metadata.');
            return date.toISOString();
        }
        default:
            return value;
    }
}
export function DocumentMetadata({
    collectionId,
    document,
    fields,
    onClose,
}: Readonly<{
    collectionId: string;
    document: IndexDocument;
    fields: MetadataFields;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag.indexing');
    const { client } = useORPC();
    const action = useIndexAction();
    return (
        <CatalogDialog
            title={tr('editMetadata')}
            description={tr('metadataHint', { name: document.name })}
            busy={action.busy}
            onClose={onClose}
        >
            <form
                className='space-y-4'
                onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void action.run(async () => {
                        const metadata: Record<
                            string,
                            string | number | boolean
                        > = {};
                        for (const [field, type] of Object.entries(fields)) {
                            const value = String(
                                data.get(`metadata:${field}`) ?? ''
                            ).trim();
                            if (value !== '')
                                metadata[field] = typedMetadataValue(
                                    value,
                                    type
                                );
                        }
                        await client.admin.rag.indexing.updateMetadata({
                            collectionId,
                            documentId: document.documentId,
                            expectedMetadataRevision: document.metadataRevision,
                            language: documentMetadataLanguage(
                                data.get('language')
                            ),
                            tags: documentTags.parse(
                                String(data.get('tags') ?? '')
                                    .split(',')
                                    .map((tag) => tag.trim())
                                    .filter(Boolean)
                            ),
                            metadata: documentMetadata.parse(metadata),
                        });
                    }, onClose);
                }}
            >
                <fieldset className='space-y-4' disabled={action.busy}>
                    <SelectField
                        label={tr('language')}
                        name='language'
                        defaultValue={document.language}
                    >
                        {(['FR', 'EN', 'MIXED', 'UNDETERMINED'] as const).map(
                            (language) => (
                                <option key={language} value={language}>
                                    {tr(`languages.${language}`)}
                                </option>
                            )
                        )}
                    </SelectField>
                    <TextField
                        label={tr('tags')}
                        name='tags'
                        maxLength={1300}
                        defaultValue={document.tags.join(', ')}
                    />
                    {Object.entries(fields).map(([field, type]) =>
                        type === 'BOOLEAN' ? (
                            <SelectField
                                key={field}
                                label={field}
                                name={`metadata:${field}`}
                                defaultValue={
                                    document.metadata[field] === undefined
                                        ? ''
                                        : String(document.metadata[field])
                                }
                            >
                                <option value=''>{tr('unset')}</option>
                                <option value='true'>{tr('true')}</option>
                                <option value='false'>{tr('false')}</option>
                            </SelectField>
                        ) : (
                            <TextField
                                key={field}
                                label={tr('typedField', {
                                    field,
                                    type: tr(`fieldTypes.${type}`),
                                })}
                                name={`metadata:${field}`}
                                type={
                                    type === 'NUMBER'
                                        ? 'number'
                                        : type === 'DATE'
                                          ? 'date'
                                          : 'text'
                                }
                                step={type === 'NUMBER' ? 'any' : undefined}
                                maxLength={2000}
                                defaultValue={
                                    type === 'DATE'
                                        ? String(
                                              document.metadata[field] ?? ''
                                          ).slice(0, 10)
                                        : String(document.metadata[field] ?? '')
                                }
                            />
                        )
                    )}
                    {Object.keys(fields).length === 0 && (
                        <p className='text-sm text-muted-foreground'>
                            {tr('noFields')}
                        </p>
                    )}
                </fieldset>
                <IndexError error={action.error} />
                <Button disabled={action.busy}>
                    {action.busy ? tr('working') : tr('saveMetadata')}
                </Button>
            </form>
        </CatalogDialog>
    );
}
function documentMetadataLanguage(value: FormDataEntryValue | null) {
    if (
        value === 'FR' ||
        value === 'EN' ||
        value === 'MIXED' ||
        value === 'UNDETERMINED'
    )
        return value;
    return 'UNDETERMINED';
}
