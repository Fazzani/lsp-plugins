import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { nativeServer } from './lsp-share.mjs';

const source = JSON.parse(readFileSync(new URL('../lsp-config/claude.json', import.meta.url), 'utf8'));
const target = new URL('../lsp-config/servers.json', import.meta.url);
// Copilot launches servers directly: its substitution of ${CLAUDE_PLUGIN_ROOT} is unverified.
const config = {
  lspServers: Object.fromEntries(Object.entries(source).map(([name, server]) => [name, {
    ...nativeServer(server),
    fileExtensions: server.extensionToLanguage,
  }])),
};

if (process.argv.includes('--check')) {
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), config,
    'Copilot LSP configuration is stale; run npm run sync');
} else {
  mkdirSync(new URL('../lsp-config/', import.meta.url), { recursive: true });
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
}
