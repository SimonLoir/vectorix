'use client';

import { useContext } from 'react';
import { AuthContext } from '../contexts/auth';

export const useAuth = () => {
    const data = useContext(AuthContext);
    if (!data) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return data;
};
