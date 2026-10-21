'use client';

import * as React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Button } from './button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from './dropdown-menu';

export interface ModeToggleLabels {
    label: string;
    light: string;
    dark: string;
    system: string;
}

const defaultLabels: ModeToggleLabels = {
    label: 'Toggle theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
};

export function ModeToggle({
    labels = defaultLabels,
}: Readonly<{ labels?: ModeToggleLabels }>) {
    const { setTheme } = useTheme();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant='outline' size='icon'>
                    <Sun className='h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90' />
                    <Moon className='absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0' />
                    <span className='sr-only'>{labels.label}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
                <DropdownMenuItem onClick={() => setTheme('light')}>
                    {labels.light}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('dark')}>
                    {labels.dark}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('system')}>
                    {labels.system}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
