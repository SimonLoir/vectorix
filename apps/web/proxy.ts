import { NextRequest, NextResponse } from 'next/server';
import { authClient } from '@repo/dashboard-core/lib/auth-client';
export async function proxy(request: NextRequest) {
    const { data: session } = await authClient.getSession({
        fetchOptions: { headers: request.headers },
    });
    const authenticationPage = ['/sign-in', '/sign-up'].includes(
        request.nextUrl.pathname
    );
    if (session && authenticationPage)
        return NextResponse.redirect(new URL('/dashboard', request.url));
    if (!session && !authenticationPage)
        return NextResponse.redirect(new URL('/sign-in', request.url));
    return NextResponse.next();
}
export const config = {
    matcher: ['/dashboard/:path*', '/sign-in', '/sign-up'],
};
