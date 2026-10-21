'use client';

import { useContext } from 'react';
import { ORPCContext } from '@/contexts/orpc';

export function useORPC() {
    const value = useContext(ORPCContext);
    if (!value) {
        throw new Error('useORPC must be used within an ORPCProvider');
    }

    return value;
}
