import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { guard, symbolSearch } from '../scripts/grep-guard.mjs';

const extensions = ['.cs', '.razor', '.ts', '.tsx', '.yaml'];

test('Grep guard flags code-symbol lookups in covered files', () => {
  const cases = [
    [{ pattern: 'SyncFromArchiveAsync', output_mode: 'content' }, 'SyncFromArchiveAsync'],
    [{ pattern: '\\bOrderService\\b', type: 'cs' }, 'OrderService'],
    [{ pattern: 'class NativePluginFixture', path: 'D:\\repo\\tests' }, 'NativePluginFixture'],
    [{ pattern: 'public sealed class ExternalFeed', path: 'src' }, 'ExternalFeed'],
    [{ pattern: 'CreateBuilder\\(', path: 'src\\Program.cs' }, 'CreateBuilder'],
    [{ pattern: ': ISettingsService', glob: '*.cs' }, 'ISettingsService'],
    [{ pattern: 'Origin|ExternalFeedId|IsSystem', path: 'src\\Service.cs' }, 'ExternalFeedId'],
    [{ pattern: 'router\\.refresh', glob: '**/*.{ts,tsx}' }, 'refresh'],
  ];
  for (const [input, symbol] of cases) assert.equal(symbolSearch(input, extensions), symbol, input.pattern);
});

test('Grep guard allows literal text, regexes and uncovered files', () => {
  const cases = [
    { pattern: 'TODO' },
    { pattern: 'ASPNETCORE_ENVIRONMENT' },
    { pattern: 'marketplace' },
    { pattern: 'Skipped' },
    { pattern: 'Commit\\w*Sha|SourceCommit' },
    { pattern: 'Status = |RegistryItemStatus\\.' },
    { pattern: 'SyncFromArchiveAsync', '-i': true },
    { pattern: 'SyncFromArchiveAsync', glob: '*.md' },
    { pattern: 'SyncFromArchiveAsync', glob: '*.css' },
    { pattern: 'SyncFromArchiveAsync', type: 'json' },
    { pattern: 'SyncFromArchiveAsync', path: 'D:\\repo\\docs' },
    { pattern: 'SyncFromArchiveAsync', path: 'docs\\technique.md' },
    { pattern: 'SyncFromArchiveAsync', path: 'pipelines\\build.yaml' },
    { pattern: 'SyncFromArchiveAsync', path: 'Pages\\Index.razor' },
  ];
  for (const input of cases) assert.equal(symbolSearch(input, extensions), null, JSON.stringify(input));
  assert.equal(symbolSearch({ pattern: 'SyncFromArchiveAsync' }, ['.yaml']), null);
  assert.equal(symbolSearch({ pattern: 'SyncFromArchiveAsync' }, []), null);
});

test('Grep guard denies a symbol lookup once per session, then allows the identical retry', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'local lsp guard '));
  try {
    const event = { session_id: 'abc-123', tool_input: { pattern: 'SyncFromArchiveAsync' } };
    const denial = guard(event, extensions, stateDir);
    assert.equal(denial.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denial.hookSpecificOutput.permissionDecisionReason, /workspaceSymbol with query 'SyncFromArchiveAsync'/);
    assert.equal(guard(event, extensions, stateDir), null);
    assert.notEqual(guard({ ...event, session_id: 'other' }, extensions, stateDir), null);
    assert.equal(guard({ session_id: 'abc-123', tool_input: { pattern: 'TODO' } }, extensions, stateDir), null);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
