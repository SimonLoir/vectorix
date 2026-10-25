'use client';
import { useTranslations } from 'next-intl';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CheckField, TextField } from '../form-fields';
import { SearchDocumentFilter } from './search-document-filter';
import { MetadataFilters } from './metadata-filters';
import type { MetadataFields } from './types';

/** Share the bounded filter controls between collection and home search. */
export function SearchFilterFields({
    collectionId,
    fields,
}: Readonly<{
    collectionId: string;
    fields: MetadataFields;
}>) {
    const tr = useTranslations('rag.indexing');
    const { can, canOperation } = useVectorixPermissions();
    const canInspectDocuments =
        can({ ragLibrary: ['read'] }) &&
        canOperation('admin.rag.indexing.documents');
    return (
        <div className='space-y-4'>
            <fieldset className='space-y-2'>
                <legend className='mb-2 text-sm font-medium'>
                    {tr('language')}
                </legend>
                <div className='flex flex-wrap gap-4'>
                    {(['FR', 'EN', 'MIXED', 'UNDETERMINED'] as const).map(
                        (language) => (
                            <CheckField
                                key={language}
                                name='language'
                                value={language}
                                label={tr(`languages.${language}`)}
                            />
                        )
                    )}
                </div>
            </fieldset>
            <fieldset className='space-y-2'>
                <legend className='mb-2 text-sm font-medium'>
                    {tr('fileTypes')}
                </legend>
                <div className='flex flex-wrap gap-4'>
                    {[
                        ['PDF', 'application/pdf'],
                        [
                            'DOCX',
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        ],
                        ['TXT', 'text/plain'],
                        ['Markdown', 'text/markdown'],
                    ].map(([label, value]) => (
                        <CheckField
                            key={value}
                            name='mediaType'
                            value={value}
                            label={label!}
                        />
                    ))}
                </div>
            </fieldset>
            <TextField label={tr('tags')} name='tags' maxLength={1300} />
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label={tr('createdAfter')}
                    name='createdAfter'
                    type='date'
                />
                <TextField
                    label={tr('createdBefore')}
                    name='createdBefore'
                    type='date'
                />
            </div>
            {canInspectDocuments && collectionId && (
                <SearchDocumentFilter collectionId={collectionId} />
            )}
            <MetadataFilters fields={fields} />
        </div>
    );
}
