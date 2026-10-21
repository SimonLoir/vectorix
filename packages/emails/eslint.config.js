import { config } from '@repo/eslint-config/react-internal';

/** @type {import("eslint").Linter.Config[]} */
export default [
    ...config,
    {
        rules: {
            // react/prefer-read-only-props crashes with ESLint v10 due to
            // eslint-plugin-react incompatibility (getFilename not a function)
            'react/prefer-read-only-props': 'off',
        },
    },
];
