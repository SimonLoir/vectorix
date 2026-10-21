import { defineConfig } from 'vite';
export default defineConfig({
    ssr: { noExternal: [/^@repo\//, /^@routers\//] },
    build: {
        ssr: 'src/index.ts',
        target: 'node24',
        outDir: 'dist',
        rollupOptions: {
            external: (id) =>
                !id.startsWith('.') &&
                !id.startsWith('/') &&
                !id.startsWith('@repo/') &&
                !id.startsWith('@routers/'),
            output: { entryFileNames: 'index.mjs', format: 'esm' },
        },
    },
});
