'use client';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import { Textarea } from '@repo/ui/textarea';

export function TextField({
    label,
    ...props
}: Readonly<{ label: string } & ComponentProps<typeof Input>>) {
    const id = useId();
    return (
        <div className='space-y-2'>
            <Label htmlFor={id}>{label}</Label>
            <Input id={id} {...props} />
        </div>
    );
}
export function AreaField({
    label,
    ...props
}: Readonly<{ label: string } & ComponentProps<typeof Textarea>>) {
    const id = useId();
    return (
        <div className='space-y-2'>
            <Label htmlFor={id}>{label}</Label>
            <Textarea id={id} {...props} />
        </div>
    );
}
export function SelectField({
    label,
    children,
    ...props
}: Readonly<
    { label: string; children: ReactNode } & ComponentProps<'select'>
>) {
    const id = useId();
    return (
        <div className='space-y-2'>
            <Label htmlFor={id}>{label}</Label>
            <select
                id={id}
                className='border-input bg-background h-10 w-full rounded-md border px-3 text-sm'
                {...props}
            >
                {children}
            </select>
        </div>
    );
}
export function CheckField({
    label,
    ...props
}: Readonly<{ label: string } & ComponentProps<'input'>>) {
    return (
        <label className='flex items-start gap-2 text-sm'>
            <input
                type='checkbox'
                className='mt-0.5 size-4 accent-primary'
                {...props}
            />
            <span>{label}</span>
        </label>
    );
}
