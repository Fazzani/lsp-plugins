import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bridgeConfig, findExecutable } from '../scripts/mcp.mjs';

const source = JSON.parse(readFileSync(new URL('../lsp-config/claude.json', import.meta.url), 'utf8'));

test('all native extension mappings preserve their language IDs in the MCP bridge', () => {
  const config = bridgeConfig(source, process.cwd());
  assert.equal(config.mcp.read_only, true);
  const extensions = new Map();
  for (const server of config.servers) {
    assert.equal(server.root_dir, process.cwd());
    for (const extension of server.extensions) {
      assert.equal(extensions.has(extension), false, `Duplicate extension: ${extension}`);
      extensions.set(extension, server.language_id);
    }
  }
  for (const server of Object.values(source)) {
    for (const [extension, language] of Object.entries(server.extensionToLanguage)) {
      assert.equal(extensions.get(extension.slice(1)), language);
    }
  }
  assert.deepEqual(Object.keys(source).sort(), ['csharp', 'dart', 'php', 'python', 'terraform', 'typescript', 'yaml']);
});

test('Windows PATH lookup resolves cmd and bat shims, including paths containing spaces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'local lsp test '));
  try {
    writeFileSync(join(directory, 'server.cmd'), '');
    writeFileSync(join(directory, 'dart.bat'), '');
    assert.equal(findExecutable('server', directory, 'win32'), join(directory, 'server.cmd'));
    assert.equal(findExecutable('dart', directory, 'win32'), join(directory, 'dart.bat'));
    assert.equal(findExecutable('missing', directory, 'win32'), 'missing');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('client manifests have matching identities and only Codex enables MCP', () => {
  const claude = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const codex = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(claude.name, codex.name);
  assert.equal(claude.version, codex.version);
  assert.equal(claude.lspServers, './lsp-config/claude.json');
  assert.equal(claude.mcpServers, undefined);
  assert.equal(codex.mcpServers['local-lsp'].command, 'local-lsp-mcp');
  const copilot = JSON.parse(readFileSync(new URL('../.github/plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(copilot.name, claude.name);
  assert.equal(copilot.version, claude.version);
  assert.equal(copilot.lspServers, './lsp-config/servers.json');
  for (const manifest of [claude, codex, copilot]) {
    assert.equal(manifest.skills, './skills/');
    const skill = new URL(`../${manifest.skills}lsp-doctor/SKILL.md`, import.meta.url);
    assert(readFileSync(skill, 'utf8').startsWith('---\n'));
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, claude.version);
  assert(pkg.files.includes('skills'));
});

test('npm-linked launcher executes through a directory symlink and reports a missing bridge', () => {
  const directory = mkdtempSync(join(tmpdir(), 'local lsp linked '));
  try {
    const alias = join(directory, 'plugin');
    symlinkSync(fileURLToPath(new URL('../', import.meta.url)), alias, 'junction');
    const result = spawnSync(process.execPath, [join(alias, 'scripts', 'mcp.mjs'), '--doctor'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, LOCAL_LSP_LSPI: join(directory, 'missing-lspi') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Install lspi 0\.2\.0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
