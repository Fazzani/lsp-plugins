#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

export function findExecutable(command, path = process.env.PATH ?? '', platform = process.platform) {
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, command + suffix);
      try {
        accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Continue to the next PATH entry. */ }
    }
  }
  return command;
}

export function bridgeConfig(source, workspaceRoot) {
  return {
    workspace_root: workspaceRoot,
    mcp: { read_only: true },
    servers: Object.entries(source).flatMap(([name, server]) => {
      // lspi uses one language ID per server, whereas native clients map it per extension.
      const languages = {};
      for (const [extension, language] of Object.entries(server.extensionToLanguage)) {
        (languages[language] ??= []).push([extension, language]);
      }
      return Object.entries(languages).map(([language, extensions]) => ({
        id: `${name}-${language}`,
        kind: 'generic',
        // Shared servers run through node and the plugin's lsp-share.mjs, as in Claude Code.
        command: server.command === 'node' ? process.execPath : findExecutable(server.command),
        args: server.args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT)),
        extensions: extensions.map(([extension]) => extension.slice(1)),
        language_id: language,
        root_dir: workspaceRoot,
        initialize_timeout_ms: 60000,
        request_timeout_ms: server.requestTimeout ?? 60000,
        ...(name === 'typescript' ? { adapter: 'tsserver' } : {}),
      }));
    }),
  };
}

export async function main() {
  const source = JSON.parse(readFileSync(new URL('../lsp-config/claude.json', import.meta.url), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'local-lsp-'));
  const configPath = join(directory, 'config.json');
  const workspace = process.cwd();
  writeFileSync(configPath, JSON.stringify(bridgeConfig(source, workspace)));
  let executable = process.env.LOCAL_LSP_LSPI || findExecutable('lspi');
  if (executable === 'lspi') {
    executable = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'lspi.exe' : 'lspi');
  }
  const mode = process.argv.includes('--doctor') ? 'doctor' : 'mcp';
  const child = spawn(executable, [mode, '--config', configPath, '--workspace-root', workspace,
    ...(mode === 'mcp' ? ['--read-only'] : ['--json'])], {
    stdio: [mode === 'mcp' ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    // lspi's default tracing writer is stdout; keep the MCP channel protocol-only.
    env: { ...process.env, RUST_LOG: 'off' },
  });
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  process.once('exit', cleanup);
  let stopping = false;
  let stopExitCode = 0;
  const stop = (exitCode = 0) => {
    if (stopping || !child.pid) return;
    stopping = true;
    stopExitCode = exitCode;
    // lspi 0.2.0 can leave LSP descendants alive on EOF. Stop only this process tree.
    if (process.platform === 'win32') {
      spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  if (mode === 'mcp') {
    process.stdin.pipe(child.stdin, { end: false });
    process.stdin.once('end', () => stop());
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') console.error(error.message); });
  }
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  child.once('error', error => {
    console.error(`local-lsp: ${error.message}. Install lspi 0.2.0 on PATH or in ~/.local/bin.`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.stdin.unpipe();
    process.stdin.pause();
    process.exitCode = stopping ? stopExitCode : (code !== null && code >= 0 ? code : 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
