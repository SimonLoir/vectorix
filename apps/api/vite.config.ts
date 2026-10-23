import { defineConfig, type Plugin } from 'vite';
import {
    readInstalledScalarBundle,
    SCALAR_PACKAGED_FILE,
} from './src/api-versioning/scalar-bundle.ts';

/** Copy the pinned browser bytes; Scalar's Vue/AI dependency graph stays build-only. */
function scalarBrowserAsset(): Plugin {
    return {
        name: 'vectorix-scalar-browser-asset',
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: SCALAR_PACKAGED_FILE,
                source: readInstalledScalarBundle(),
            });
        },
    };
}

export default defineConfig({
    define: { __VECTORIX_PACKAGED_SCALAR__: 'true' },
    plugins: [scalarBrowserAsset()],
    ssr: { noExternal: [/^@repo\//, /^@routers\//] },
    build: {
        ssr: 'src/index.ts',
        target: 'node24',
        outDir: 'dist',
        // SSR defaults to dropping emitted assets; the runtime requires this exact sibling file.
        emitAssets: true,
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
