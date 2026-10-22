#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { nativeServer } from './lsp-share.mjs';
import { findExecutable } from './mcp.mjs';

export const loadSource = () =>
  JSON.parse(readFileSync(new URL('../lsp-config/claude.json', import.meta.url), 'utf8'));

/** Extensions (with leading dot) whose configured language server resolves on PATH. */
export function installedExtensions(source, path = process.env.PATH ?? '', platform = process.platform) {
  return Object.values(source)
    .filter((server) => {
      const { command } = nativeServer(server);
      return findExecutable(command, path, platform) !== command;
    })
    .flatMap((server) => Object.keys(server.extensionToLanguage));
}

/**
 * Builds the Claude Code SessionStart reminder for the language servers found on PATH.
 * Claude Code defers the LSP tool and LSP needs a position, so the reminder gives the
 * Grep-free path: workspaceSymbol locates the symbol, then position-based operations.
 * Returns an empty string when no configured server is installed.
 */
export function reminder(extensions) {
  if (extensions.length === 0) return '';
  return `local-lsp: language servers are available for ${extensions.join(', ')}.\n`
    + 'For code symbols (definition, references, implementations, callers, type), use the LSP tool, not Grep: '
    + 'load it with `ToolSearch select:LSP`, locate the symbol with `workspaceSymbol` (query = name, filePath = any '
    + 'covered file, line 1, character 1), then call findReferences / goToDefinition / goToImplementation / '
    + 'incomingCalls at the returned position. Trust LSP results; do not re-verify them with Grep. '
    + 'The first call after startup may return nothing while the server indexes: retry it before falling back.\n'
    + 'Use Grep only for literal text: strings, log messages, comments, configuration keys, uncovered files.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const additionalContext = reminder(installedExtensions(loadSource()));
  if (additionalContext) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  }
}
