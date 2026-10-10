import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reminder } from '../scripts/session-start.mjs';

const source = {
  csharp: { command: 'roslyn-language-server', extensionToLanguage: { '.cs': 'csharp' } },
  dart: { command: 'dart', extensionToLanguage: { '.dart': 'dart' } },
};

test('SessionStart reminder lists only installed servers and how to load the deferred LSP tool', () => {
  const directory = mkdtempSync(join(tmpdir(), 'local lsp reminder '));
  try {
    writeFileSync(join(directory, 'roslyn-language-server.cmd'), '');
    const text = reminder(source, directory, 'win32');
    assert.match(text, /\.cs\b/);
    assert.doesNotMatch(text, /\.dart/);
    assert.match(text, /ToolSearch select:LSP/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SessionStart reminder is silent when no server is installed', () => {
  assert.equal(reminder(source, '', 'win32'), '');
});
