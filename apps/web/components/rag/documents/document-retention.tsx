'use client';
import { useTranslations } from 'next-intl';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';

/** Use a whole-day delay; the API independently enforces the same bounds. */
export function DocumentRetention({
    value,
    onChange,
    disabled,
    deletion = false,
}: Readonly<{
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
    deletion?: boolean;
}>) {
    const tr = useTranslations('rag.documents.lifecycle');
    return (
        <div className='space-y-2'>
            <Label htmlFor='document-retention'>{tr('retentionLabel')}</Label>
            <Input
                id='document-retention'
                type='number'
                inputMode='numeric'
                min={0}
                max={365}
                step={1}
                required
                disabled={disabled}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                aria-describedby='document-retention-hint'
            />
            <p
                id='document-retention-hint'
                className='text-sm text-muted-foreground'
            >
                {tr(deletion ? 'deleteRetentionHint' : 'replaceRetentionHint')}
            </p>
        </div>
    );
}

/** Accept an explicit whole-day retention delay in the supported product range. */
export function validRetention(value: string) {
    return (
        value.trim() !== '' &&
        Number.isInteger(Number(value)) &&
        Number(value) >= 0 &&
        Number(value) <= 365
    );
}
