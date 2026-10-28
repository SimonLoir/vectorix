import {
    serveStdio,
    StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { createVectorixClient } from '@vectorix/client';
import { readConfiguration } from './config';
import { TOOL_TIMEOUT_MS } from './execution';
import { createVectorixMcpServer } from './server';

/** Stdout belongs exclusively to MCP; neither configuration nor native errors are printed. */
try {
    const configuration = readConfiguration(process.env);
    const client = createVectorixClient({
        apiUrl: configuration.apiUrl,
        apiKey: configuration.apiKey,
        organizationId: configuration.organizationId,
        timeoutMs: TOOL_TIMEOUT_MS,
    });
    const handle = serveStdio(
        () => createVectorixMcpServer(configuration, client),
        {
            transport: new StdioServerTransport(process.stdin, process.stdout, {
                maxBufferSize: 64 * 1024,
            }),
            maxSubscriptions: 1,
            onerror: () => {
                process.stderr.write('Vectorix MCP transport error.\n');
            },
        }
    );
    const shutdown = () => {
        void handle.close().catch(() => {
            process.stderr.write('Vectorix MCP shutdown failed.\n');
            process.exitCode = 1;
        });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
} catch {
    process.stderr.write('Vectorix MCP configuration is invalid.\n');
    process.exitCode = 1;
}
