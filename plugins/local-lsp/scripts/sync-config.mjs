import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const source = JSON.parse(readFileSync(new URL('../lsp-config/claude.json', import.meta.url), 'utf8'));
const target = new URL('../lsp-config/servers.json', import.meta.url);
const config = {
  lspServers: Object.fromEntries(Object.entries(source).map(([name, server]) => [name, {
    command: server.command,
    args: server.args,
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
