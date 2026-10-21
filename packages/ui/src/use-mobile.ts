import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

function getIsMobileViewport() {
    if (globalThis.window === undefined) {
        return false;
    }

    return globalThis.window.innerWidth < MOBILE_BREAKPOINT;
}

export function useIsMobile() {
    const [isMobile, setIsMobile] =
        React.useState<boolean>(getIsMobileViewport);

    React.useEffect(() => {
        const mql = globalThis.window.matchMedia(
            `(max-width: ${MOBILE_BREAKPOINT - 1}px)`
        );
        const onChange = (event: MediaQueryListEvent) => {
            setIsMobile(event.matches);
        };
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);

    return isMobile;
}
