'use client';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu';
import { Button } from '@repo/ui/button';
import { GlobeIcon } from 'lucide-react';

export { useLanguagePreference } from '../hooks/use-language-preference';

export type LanguageOption = {
    code: string;
    label: string;
};

export interface LanguageSwitcherProps {
    locale: string;
    onLocaleChange: (locale: string) => void;
    languages: LanguageOption[];
    srLabel?: string;
    disabled?: boolean;
    busy?: boolean;
}

export function LanguageSwitcher({
    locale,
    onLocaleChange,
    languages,
    srLabel = 'Switch language',
    disabled = false,
    busy = false,
}: Readonly<LanguageSwitcherProps>) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant='ghost'
                    size='sm'
                    className='gap-2'
                    disabled={disabled}
                    aria-busy={busy}
                >
                    <GlobeIcon aria-hidden='true' className='size-4' />
                    <span className='sr-only'>{srLabel}</span>
                    <span className='text-xs uppercase'>{locale}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
                {languages.map(({ code, label }) => (
                    <DropdownMenuItem
                        key={code}
                        onClick={() => onLocaleChange(code)}
                        disabled={disabled}
                        className={locale === code ? 'font-medium' : ''}
                    >
                        {label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
