'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { TextField, SelectField } from '../form-fields';
import type { MetadataFields as Fields } from '../indexing/types';

export function MetadataFields({
    initial = {},
}: Readonly<{ initial?: Fields }>) {
    const tr = useTranslations('rag.indexing');
    const [rows, setRows] = useState(() =>
        Object.entries(initial).map(([key, type]) => ({
            id: crypto.randomUUID(),
            key,
            type,
        }))
    );
    const fields = Object.fromEntries(rows.map((row) => [row.key, row.type]));
    const valid =
        rows.every((row) => /^[a-z][a-z0-9_]{0,63}$/.test(row.key)) &&
        Object.keys(fields).length === rows.length;
    return (
        <fieldset className='space-y-4 rounded-lg border p-4'>
            <legend className='px-2 font-medium'>{tr('metadataFields')}</legend>
            <p className='text-sm text-muted-foreground'>
                {tr('metadataFieldsHint')}
            </p>
            <input
                type='hidden'
                name='metadataFieldsValid'
                value={String(valid)}
            />
            <input
                type='hidden'
                name='metadataFields'
                value={JSON.stringify(fields)}
            />
            {rows.map((row) => (
                <div
                    key={row.id}
                    className='grid gap-3 sm:grid-cols-[1fr_1fr_auto]'
                >
                    <TextField
                        label={tr('fieldKey')}
                        value={row.key}
                        pattern='[a-z][a-z0-9_]{0,63}'
                        required
                        maxLength={64}
                        onChange={(event) =>
                            setRows((previous) =>
                                previous.map((item) =>
                                    item.id === row.id
                                        ? { ...item, key: event.target.value }
                                        : item
                                )
                            )
                        }
                    />
                    <SelectField
                        label={tr('fieldType')}
                        value={row.type}
                        onChange={(event) => {
                            const type = event.target.value;
                            if (
                                type === 'STRING' ||
                                type === 'NUMBER' ||
                                type === 'BOOLEAN' ||
                                type === 'DATE'
                            )
                                setRows((previous) =>
                                    previous.map((item) =>
                                        item.id === row.id
                                            ? { ...item, type }
                                            : item
                                    )
                                );
                        }}
                    >
                        {(['STRING', 'NUMBER', 'BOOLEAN', 'DATE'] as const).map(
                            (type) => (
                                <option key={type} value={type}>
                                    {tr(`fieldTypes.${type}`)}
                                </option>
                            )
                        )}
                    </SelectField>
                    <Button
                        type='button'
                        variant='outline'
                        className='self-end'
                        aria-label={tr('removeField', {
                            field: row.key || tr('newField'),
                        })}
                        onClick={() =>
                            setRows((previous) =>
                                previous.filter((item) => item.id !== row.id)
                            )
                        }
                    >
                        {tr('remove')}
                    </Button>
                </div>
            ))}
            {!valid && (
                <p role='alert' className='text-sm'>
                    {tr('invalidFields')}
                </p>
            )}
            <Button
                type='button'
                variant='outline'
                disabled={rows.length >= 20}
                onClick={() =>
                    setRows((previous) => [
                        ...previous,
                        { id: crypto.randomUUID(), key: '', type: 'STRING' },
                    ])
                }
            >
                {tr('addField')}
            </Button>
        </fieldset>
    );
}
