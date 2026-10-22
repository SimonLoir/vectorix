import { defineConfig } from 'vite';
export default defineConfig({
    ssr: { noExternal: [/^@repo\//, /^@routers\//] },
    build: {
        ssr: true,
        target: 'node24',
        outDir: 'dist',
        rollupOptions: {
            input: {
                index: 'src/index.ts',
                'docx-thread': 'src/extraction/docx-thread.ts',
                'document-parser': 'src/extraction/main.ts',
            },
            external: (id) =>
                !id.startsWith('.') &&
                !id.startsWith('/') &&
                !id.startsWith('@repo/') &&
                !id.startsWith('@routers/'),
            output: {
                entryFileNames: '[name].mjs',
                chunkFileNames: '[name]-[hash].mjs',
                format: 'esm',
            },
        },
    },
});
