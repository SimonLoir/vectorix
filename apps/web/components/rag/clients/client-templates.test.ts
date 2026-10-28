import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { mcpTemplate, sdkTemplate } from './client-templates';

void test('MCP configuration keeps exact connection literals and a key placeholder without executing them', () => {
    const connection = {
        apiUrl: 'https://example.test/"; INJECTED(); \n',
        organizationId: 'organization-"\n',
        collectionId: 'collection-"\n',
    };
    const config = JSON.parse(mcpTemplate(connection));
    assert.deepEqual(config.mcpServers.vectorix, {
        command: 'node',
        args: ['/absolute/path/to/vectorix-mcp/dist/cli.mjs'],
        env: {
            VECTORIX_API_URL: connection.apiUrl,
            VECTORIX_API_KEY: 'YOUR_VECTORIX_API_KEY',
            VECTORIX_ORGANIZATION_ID: connection.organizationId,
            VECTORIX_COLLECTION_IDS: connection.collectionId,
        },
    });
});

void test('SDK templates encode deployment values and translated questions as literal strings', () => {
    const connection = {
        apiUrl: 'https://example.test/"; INJECTED();\n',
        organizationId: 'org-"\n',
        collectionId: 'collection-"\n',
    };
    const question = '"; INJECTED();\nWhich insects?';
    const code = sdkTemplate(connection, question);
    const emitted = ts.transpileModule(code, {
        reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    });
    assert.deepEqual(
        (emitted.diagnostics ?? []).filter(
            (item) => item.category === ts.DiagnosticCategory.Error
        ),
        []
    );
    const source = ts.createSourceFile(
        'template.ts',
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const strings: string[] = [];
    const identifiers: string[] = [];
    function visit(node: ts.Node) {
        if (ts.isStringLiteral(node)) strings.push(node.text);
        if (ts.isIdentifier(node)) identifiers.push(node.text);
        ts.forEachChild(node, visit);
    }
    visit(source);
    for (const value of [...Object.values(connection), question])
        assert.ok(strings.includes(value));
    assert.equal(identifiers.includes('INJECTED'), false);
});
