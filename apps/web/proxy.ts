import { NextRequest, NextResponse } from 'next/server';
import { authClient } from '@repo/dashboard-core/lib/auth-client';
import { emailOwnershipSignInReturn } from '@repo/dashboard-core/lib/email-ownership';
export async function proxy(request: NextRequest) {
    const { data: session } = await authClient.getSession({
        fetchOptions: { headers: request.headers },
    });
    const authenticationPage = ['/sign-in', '/sign-up'].includes(
        request.nextUrl.pathname
    );
    if (session && authenticationPage)
        return NextResponse.redirect(
            new URL(
                emailOwnershipSignInReturn(
                    request.nextUrl.searchParams.get('returnTo')
                ),
                request.url
            )
        );
    if (!session && !authenticationPage) {
        const destination = emailOwnershipSignInReturn(
            `${request.nextUrl.pathname}${request.nextUrl.search}`
        );
        const signIn = new URL('/sign-in', request.url);
        if (destination !== '/dashboard')
            signIn.searchParams.set('returnTo', destination);
        return NextResponse.redirect(signIn);
    }
    return NextResponse.next();
}
export const config = {
    matcher: ['/dashboard/:path*', '/sign-in', '/sign-up'],
};
