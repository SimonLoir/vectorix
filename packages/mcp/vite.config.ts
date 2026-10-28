import { defineConfig } from 'vite';

/** Inline only the public SDK implementation; all published runtime dependencies remain external. */
export default defineConfig({
    ssr: { noExternal: ['@vectorix/client'] },
    build: {
        ssr: true,
        target: 'node24',
        outDir: 'dist',
        rollupOptions: {
            input: { cli: 'src/cli.ts' },
            external: (id) =>
                id !== '@vectorix/client' &&
                !id.startsWith('.') &&
                !id.startsWith('/'),
            output: {
                entryFileNames: '[name].mjs',
                chunkFileNames: '[name]-[hash].mjs',
                format: 'esm',
                banner: '#!/usr/bin/env node',
            },
        },
    },
});
