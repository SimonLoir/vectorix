import { useContext } from 'react';
import { ORPCContext } from '@/contexts/orpc';

export const useORPC = () => {
    const data = useContext(ORPCContext);
    if (!data) {
        throw new Error('useORPC must be used within an ORPCProvider');
    }
    return data;
};
