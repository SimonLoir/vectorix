'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar';
import { cn } from '@repo/ui/utils';

const fallbackColors = [
    'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
    'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
    'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200',
] as const;

export const PERSON_AVATAR_COLORS = [
    'BLUE',
    'EMERALD',
    'AMBER',
    'VIOLET',
    'ROSE',
    'CYAN',
] as const;
export type PersonAvatarColor = (typeof PERSON_AVATAR_COLORS)[number];

const selectedColors: Record<
    PersonAvatarColor,
    { fallback: string; ring: string }
> = {
    BLUE: { fallback: fallbackColors[0], ring: 'ring-blue-500' },
    EMERALD: { fallback: fallbackColors[1], ring: 'ring-emerald-500' },
    AMBER: { fallback: fallbackColors[2], ring: 'ring-amber-500' },
    VIOLET: { fallback: fallbackColors[3], ring: 'ring-violet-500' },
    ROSE: { fallback: fallbackColors[4], ring: 'ring-rose-500' },
    CYAN: { fallback: fallbackColors[5], ring: 'ring-cyan-500' },
};

export function personInitials(name: string) {
    const parts = name.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0) return '?';
    const first = Array.from(parts[0]!);
    const last = Array.from(parts.at(-1)!);
    return (
        parts.length === 1
            ? first.slice(0, 2).join('')
            : `${first[0] ?? ''}${last[0] ?? ''}`
    ).toLocaleUpperCase();
}

export function personAvatarColor(name: string) {
    let hash = 0;
    for (const character of name.trim().toLocaleLowerCase())
        hash = Math.trunc(
            (hash * 31 + character.codePointAt(0)!) % 2_147_483_647
        );
    return fallbackColors[Math.abs(hash) % fallbackColors.length]!;
}

export function PersonAvatar({
    name,
    image,
    color,
    className,
    fallbackClassName,
    decorative = false,
}: Readonly<{
    name: string;
    image?: string | null;
    color?: PersonAvatarColor | null;
    className?: string;
    fallbackClassName?: string;
    decorative?: boolean;
}>) {
    return (
        <Avatar
            role={decorative ? undefined : 'img'}
            aria-label={decorative ? undefined : name}
            aria-hidden={decorative || undefined}
            title={decorative ? undefined : name}
            className={cn(
                color && 'ring-2 ring-offset-1 ring-offset-background',
                color && selectedColors[color].ring,
                className
            )}
        >
            {image ? <AvatarImage src={image} alt='' /> : null}
            <AvatarFallback
                className={cn(
                    color
                        ? selectedColors[color].fallback
                        : personAvatarColor(name),
                    fallbackClassName
                )}
            >
                {personInitials(name)}
            </AvatarFallback>
        </Avatar>
    );
}
