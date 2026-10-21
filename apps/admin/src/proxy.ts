import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAuthClient } from '@repo/dashboard-core/lib/auth-client';

export async function proxy(request: NextRequest) {
    const authClient = getAuthClient(
        process.env.API_URL ?? 'http://localhost:3001'
    );
    const { data: session } = await authClient.getSession({
        fetchOptions: { headers: request.headers },
    });

    return session
        ? NextResponse.next()
        : NextResponse.redirect(new URL('/sign-in', request.url));
}

export const config = {
    matcher: ['/((?!sign-in|_next/static|_next/image|favicon.ico).*)'],
};
