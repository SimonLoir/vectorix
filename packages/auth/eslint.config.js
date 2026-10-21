import { config } from '@repo/eslint-config/base';

/** @type {import("eslint").Linter.Config[]} */
export default [
    ...config,
    {
        files: ['tests/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: false,
                project: './tsconfig.eslint.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
];
