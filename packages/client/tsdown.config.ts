import { defineConfig } from 'tsdown';

/** Inline the hand-written contract declarations; no private workspace module may escape the package. */
export default defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    clean: true,
    // Leave envFile unset: tsdown reads no environment file unless explicitly configured.
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    dts: {
        resolver: 'tsc',
        eager: true,
        // The source contracts intentionally disable declarations for their own checks.
        compilerOptions: { declaration: true, rootDir: '..' },
    },
    deps: {
        alwaysBundle: [/^@repo\/api-contracts(?:\/|$)/u],
        neverBundle: ['@orpc/client', '@orpc/contract', 'zod'],
        onlyImport: ['@orpc/client', '@orpc/contract', 'zod'],
    },
});
