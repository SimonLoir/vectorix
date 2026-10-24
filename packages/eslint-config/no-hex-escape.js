/**
 * Preserve Unicorn63's no-hex-escape coverage, including JSX and custom tags.
 * Adapted from eslint-plugin-unicorn63.0.0 (MIT, see no-hex-escape.LICENSE):
 * https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v63.0.0/rules/no-hex-escape.js
 * The legacy prefix/parity and fix behavior are intentional; no autofix is run
 * against application code by this module.
 */
const messages = {
    'no-hex-escape': 'Use Unicode escapes instead of hexadecimal escapes.',
};

/** Match only the old syntactic, noncomputed String.raw exemption. */
function isStringRaw(template) {
    const parent = template.parent;
    const tag = parent?.tag;
    return (
        template.type === 'TemplateLiteral' &&
        parent?.type === 'TaggedTemplateExpression' &&
        parent.quasi === template &&
        tag?.type === 'MemberExpression' &&
        !tag.optional &&
        !tag.computed &&
        tag.object.type === 'Identifier' &&
        tag.object.name === 'String' &&
        tag.property.type === 'Identifier' &&
        tag.property.name === 'raw'
    );
}

export default {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Preserve the Unicorn63 hexadecimal-escape check.',
            url: 'https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v63.0.0/docs/rules/no-hex-escape.md',
        },
        schema: [],
        fixable: 'code',
        messages,
    },
    create(context) {
        function check(node, raw) {
            const replacement = raw.replaceAll(
                /(?<=(?:^|[^\\])(?:\\\\)*\\)x/g,
                'u00'
            );
            if (replacement === raw) return;
            context.report({
                node,
                messageId: 'no-hex-escape',
                fix(fixer) {
                    if (node.type !== 'TemplateElement')
                        return fixer.replaceText(node, replacement);
                    const [start, end] = context.sourceCode.getRange(node);
                    return fixer.replaceTextRange(
                        [start + 1, end - (node.tail ? 1 : 2)],
                        replacement
                    );
                },
            });
        }
        return {
            Literal(node) {
                if (typeof node.value === 'string' || node.regex)
                    check(node, node.raw);
            },
            TemplateElement(node) {
                if (!isStringRaw(node.parent)) check(node, node.value.raw);
            },
        };
    },
};
