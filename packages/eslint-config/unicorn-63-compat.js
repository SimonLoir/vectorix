import unicorn from 'eslint-plugin-unicorn';
import policy from './unicorn-63-policy.json' with { type: 'json' };
import noHexEscape from './no-hex-escape.js';

/** Keep legacy rule identities live without mutating the imported plugin. */
export const unicorn63Plugin = {
    ...unicorn,
    rules: {
        ...unicorn.rules,
        'no-array-for-each': unicorn.rules['no-for-each'],
        'prefer-dom-node-dataset': unicorn.rules['dom-node-dataset'],
        'no-hex-escape': noHexEscape,
    },
};

/**
 * Freeze the actual63 selection/core/globals policy on the78 engine.
 * New rules are unselected; retained engine fixes can add diagnostics. Explicit
 * options retain old fractional grouping and never disable old alias checks.
 */
export const unicorn63Config = {
    name: 'vectorix/unicorn-63-policy-on-78',
    languageOptions: { globals: { ...policy.globals } },
    plugins: { unicorn: unicorn63Plugin },
    rules: {
        ...policy.coreRules,
        ...policy.rules,
        'unicorn/no-empty-file': ['error', { allowComments: false }],
        'unicorn/no-unreadable-array-destructuring': [
            'error',
            { maximumIgnoredElements: 1 },
        ],
        'unicorn/prefer-default-parameters': [
            'error',
            { checkFallbackExpressions: true },
        ],
        'unicorn/prefer-set-has': ['error', { minimumItems: 0 }],
        'unicorn/prefer-ternary': [
            'error',
            'always',
            { checkVaryingBase: false, checkComputedMemberAccess: false },
        ],
        'unicorn/numeric-separators-style': [
            'error',
            {
                onlyIfContainsSeparator: false,
                binary: { minimumDigits: 0, groupLength: 4 },
                octal: { minimumDigits: 0, groupLength: 4 },
                hexadecimal: { minimumDigits: 0, groupLength: 2 },
                number: {
                    minimumDigits: 5,
                    groupLength: 3,
                    fractionGroupLength: 3,
                },
            },
        ],
    },
};
