import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installedExtensions, reminder } from '../scripts/session-start.mjs';

const source = {
  csharp: { command: 'roslyn-language-server', extensionToLanguage: { '.cs': 'csharp' } },
  dart: { command: 'dart', extensionToLanguage: { '.dart': 'dart' } },
};

test('SessionStart reminder lists only installed servers and the Grep-free LSP workflow', () => {
  const directory = mkdtempSync(join(tmpdir(), 'local lsp reminder '));
  try {
    writeFileSync(join(directory, 'roslyn-language-server.cmd'), '');
    const extensions = installedExtensions(source, directory, 'win32');
    assert.deepEqual(extensions, ['.cs']);
    const text = reminder(extensions);
    assert.match(text, /ToolSearch select:LSP/);
    assert.match(text, /workspaceSymbol/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SessionStart reminder is silent when no server is installed', () => {
  assert.deepEqual(installedExtensions(source, '', 'win32'), []);
  assert.equal(reminder([]), '');
});
