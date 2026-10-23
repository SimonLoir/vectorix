export type DashboardSecurityHeaderRule = {
    source: string;
    headers: { key: string; value: string }[];
};

/** Return fresh Next.js configuration rules for the shared frontend framing defense. */
export declare function dashboardSecurityHeaderRules(): DashboardSecurityHeaderRule[];
