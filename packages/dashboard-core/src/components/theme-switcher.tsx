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
    iconOnly = false,
}: Readonly<{
    /** Render a compact square trigger; the label stays available to assistive tech. */
    iconOnly?: boolean;
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
                    size={iconOnly ? 'icon' : 'sm'}
                    className={iconOnly ? 'size-8' : undefined}
                    aria-label={labels.appearance}
                    title={iconOnly ? labels.appearance : undefined}
                    disabled={Boolean(forcedTheme)}
                >
                    <SunMoon className='size-4' aria-hidden />
                    {iconOnly ? null : (
                        <span className='hidden sm:inline'>
                            {labels.appearance}
                        </span>
                    )}
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
