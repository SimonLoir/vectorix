'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { AreaField, SelectField } from '../form-fields';
import type { MetadataFields } from './types';

export function MetadataFilters({
    fields,
}: Readonly<{ fields: MetadataFields }>) {
    const tr = useTranslations('rag.indexing');
    const keys = Object.keys(fields);
    const [rows, setRows] = useState<
        {
            id: string;
            field: string;
            operator: 'EQ' | 'IN' | 'GTE' | 'LTE';
            value: string;
        }[]
    >([]);
    if (keys.length === 0) return null;
    return (
        <fieldset className='space-y-4 rounded-lg border p-4'>
            <legend className='px-2 font-medium'>
                {tr('metadataFilters')}
            </legend>
            <p className='text-xs text-muted-foreground'>
                {tr('metadataFiltersHint')}
            </p>
            <input
                type='hidden'
                name='metadataFilters'
                value={JSON.stringify(rows)}
            />
            {rows.map((row) => (
                <div
                    key={row.id}
                    className='grid items-end gap-3 sm:grid-cols-2'
                >
                    <SelectField
                        label={tr('fieldKey')}
                        value={row.field}
                        onChange={(event) =>
                            setRows((previous) =>
                                previous.map((item) =>
                                    item.id === row.id
                                        ? {
                                              ...item,
                                              field: event.target.value,
                                              operator: 'EQ',
                                              value: '',
                                          }
                                        : item
                                )
                            )
                        }
                    >
                        {keys.map((field) => (
                            <option key={field} value={field}>
                                {field} · {tr(`fieldTypes.${fields[field]}`)}
                            </option>
                        ))}
                    </SelectField>
                    <SelectField
                        label={tr('operator')}
                        value={row.operator}
                        onChange={(event) => {
                            const operator = event.target.value;
                            if (
                                operator === 'EQ' ||
                                operator === 'IN' ||
                                operator === 'GTE' ||
                                operator === 'LTE'
                            )
                                setRows((previous) =>
                                    previous.map((item) =>
                                        item.id === row.id
                                            ? { ...item, operator }
                                            : item
                                    )
                                );
                        }}
                    >
                        <option value='EQ'>{tr('operators.EQ')}</option>
                        <option value='IN'>{tr('operators.IN')}</option>
                        {['NUMBER', 'DATE'].includes(
                            fields[row.field] ?? ''
                        ) && (
                            <>
                                <option value='GTE'>
                                    {tr('operators.GTE')}
                                </option>
                                <option value='LTE'>
                                    {tr('operators.LTE')}
                                </option>
                            </>
                        )}
                    </SelectField>
                    <AreaField
                        label={tr('filterValue')}
                        value={row.value}
                        required
                        maxLength={4000}
                        rows={row.operator === 'IN' ? 3 : 1}
                        onChange={(event) =>
                            setRows((previous) =>
                                previous.map((item) =>
                                    item.id === row.id
                                        ? { ...item, value: event.target.value }
                                        : item
                                )
                            )
                        }
                    />
                    <Button
                        type='button'
                        variant='outline'
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
            <Button
                type='button'
                variant='outline'
                disabled={rows.length >= 20}
                onClick={() =>
                    setRows((previous) => [
                        ...previous,
                        {
                            id: crypto.randomUUID(),
                            field: keys[0]!,
                            operator: 'EQ',
                            value: '',
                        },
                    ])
                }
            >
                {tr('addFilter')}
            </Button>
        </fieldset>
    );
}
