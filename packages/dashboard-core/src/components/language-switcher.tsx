'use client';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu';
import { Button } from '@repo/ui/button';
import { GlobeIcon } from 'lucide-react';

export type LanguageOption = {
    code: string;
    label: string;
};

export interface LanguageSwitcherProps {
    locale: string;
    onLocaleChange: (locale: string) => void;
    languages: LanguageOption[];
    srLabel?: string;
}

export function LanguageSwitcher({
    locale,
    onLocaleChange,
    languages,
    srLabel = 'Switch language',
}: Readonly<LanguageSwitcherProps>) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant='ghost' size='sm' className='gap-2'>
                    <GlobeIcon className='size-4' />
                    <span className='sr-only'>{srLabel}</span>
                    <span className='text-xs uppercase'>{locale}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
                {languages.map(({ code, label }) => (
                    <DropdownMenuItem
                        key={code}
                        onClick={() => onLocaleChange(code)}
                        className={locale === code ? 'font-medium' : ''}
                    >
                        {label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
