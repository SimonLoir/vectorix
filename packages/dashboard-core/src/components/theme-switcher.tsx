'use client';

import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun, SunMoon } from 'lucide-react';
import { Button } from '@repo/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu';

const choices = [
    { value: 'light', icon: Sun },
    { value: 'dark', icon: Moon },
    { value: 'system', icon: Monitor },
] as const;

/** Keep the trigger independent of the browser theme to preserve server hydration. */
export function ThemeSwitcher({
    labels,
}: Readonly<{
    labels: Readonly<{
        appearance: string;
        light: string;
        dark: string;
        system: string;
    }>;
}>) {
    const { theme = 'system', setTheme, forcedTheme } = useTheme();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label={labels.appearance}
                    disabled={Boolean(forcedTheme)}
                >
                    <SunMoon className='size-4' aria-hidden />
                    <span className='hidden sm:inline'>
                        {labels.appearance}
                    </span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
                <DropdownMenuRadioGroup
                    aria-label={labels.appearance}
                    value={theme}
                    onValueChange={(value) => {
                        if (
                            value === 'light' ||
                            value === 'dark' ||
                            value === 'system'
                        )
                            setTheme(value);
                    }}
                >
                    {choices.map(({ value, icon: Icon }) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                            <Icon className='size-4' aria-hidden />
                            {labels[value]}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
