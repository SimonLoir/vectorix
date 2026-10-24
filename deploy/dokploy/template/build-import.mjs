#!/usr/bin/env node
/**
 * Print the Base64 string for Dokploy's "Create Service > Compose > Advanced > Import".
 * It matches the Dokploy templates app: base64(JSON.stringify({ compose, config }, null, 2)),
 * where config is the raw template.toml text.
 * Usage: node deploy/dokploy/template/build-import.mjs
 */
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const json = JSON.stringify(
    { compose: read('docker-compose.yml'), config: read('template.toml') },
    null,
    2
);
process.stdout.write(`${Buffer.from(json, 'utf8').toString('base64')}\n`);
