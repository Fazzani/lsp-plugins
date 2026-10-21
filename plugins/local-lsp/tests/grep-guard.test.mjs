import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { coldIndexHint, guard, recordLspQuery, shellSymbolSearch, symbolSearch } from '../scripts/grep-guard.mjs';

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

test('Shell guard flags grep, rg and git grep symbol lookups', () => {
  const flagged = [
    ['grep -n "SyncFromArchiveAsync" src/Service.cs', 'SyncFromArchiveAsync'],
    ["rg -n 'OrderService|logging' src", 'OrderService'],
    ['cd repo && git grep -n SyncFromArchiveAsync', 'SyncFromArchiveAsync'],
    ['grep -A 3 -rn SyncFromArchiveAsync --include=*.cs .', 'SyncFromArchiveAsync'],
    ['rg -t cs -e OrderService', 'OrderService'],
    ['/usr/bin/grep -n SyncFromArchiveAsync src/Service.cs', 'SyncFromArchiveAsync'],
  ];
  for (const [command, symbol] of flagged) assert.equal(shellSymbolSearch(command, extensions), symbol, command);
  const allowed = [
    'grep -rn TODO .',
    'grep -in SyncFromArchiveAsync src',
    'grep -rn SyncFromArchiveAsync docs/',
    'rg SyncFromArchiveAsync -g "*.md"',
    'echo "grep SyncFromArchiveAsync"',
    'az containerapp show -n app | grep clientId',
    'grep -n "Commit\w*Sha|SourceCommit" src',
    'sed -n 1,5p src/Service.cs',
    '',
  ];
  for (const command of allowed) assert.equal(shellSymbolSearch(command, extensions), null, command);
});

test('Guard keeps denying a symbol lookup until the LSP has queried it', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'local lsp guard '));
  try {
    const event = { session_id: 'abc-123', tool_name: 'Grep', tool_input: { pattern: 'SyncFromArchiveAsync' } };
    const denial = guard(event, extensions, stateDir);
    assert.equal(denial.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denial.hookSpecificOutput.permissionDecisionReason, /workspaceSymbol with query 'SyncFromArchiveAsync'/);
    assert.notEqual(guard(event, extensions, stateDir), null, 'repeating the identical call is still denied');
    const shell = { session_id: 'abc-123', tool_name: 'Bash', tool_input: { command: 'grep -rn SyncFromArchiveAsync src' } };
    assert.notEqual(guard(shell, extensions, stateDir), null, 'shell grep is denied too');
    assert.equal(guard({ ...shell, tool_input: { command: 'grep -rn TODO src' } }, extensions, stateDir), null);
    recordLspQuery({ session_id: 'abc-123', tool_input: { operation: 'workspaceSymbol', query: 'syncFromArchiveAsync' } }, stateDir);
    assert.equal(guard(event, extensions, stateDir), null, 'a text search is allowed after the LSP lookup');
    assert.equal(guard(shell, extensions, stateDir), null);
    assert.notEqual(guard({ ...event, session_id: 'other' }, extensions, stateDir), null, 'state is per session');
    recordLspQuery({ session_id: 'abc-123', tool_input: { operation: 'findReferences', line: 1 } }, stateDir);
    assert.notEqual(guard({ ...event, tool_input: { pattern: 'OrderService' } }, extensions, stateDir), null);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('LSP cold-start results get a retry hint, real results do not', () => {
  const cold = 'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.';
  const hint = coldIndexHint({ hook_event_name: 'PostToolUse', tool_name: 'LSP', tool_response: cold });
  assert.match(hint.hookSpecificOutput.additionalContext, /Retry the identical LSP call/);
  assert.equal(hint.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(coldIndexHint({ tool_response: { result: 'Found 1 symbol in workspace' } }), null);
});
