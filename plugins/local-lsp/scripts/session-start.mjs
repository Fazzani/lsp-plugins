#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findExecutable } from './mcp.mjs';

/**
 * Builds the Claude Code SessionStart reminder for the language servers found on PATH.
 * The LSP tool is deferred in Claude Code, so the reminder names how to load it.
 * Returns an empty string when no configured server is installed.
 */
export function reminder(source, path = process.env.PATH ?? '', platform = process.platform) {
  const extensions = Object.values(source)
    .filter((server) => findExecutable(server.command, path, platform) !== server.command)
    .flatMap((server) => Object.keys(server.extensionToLanguage));
  if (extensions.length === 0) return '';
  return `local-lsp: language servers are available for ${extensions.join(', ')}. `
    + 'For semantic questions (definition, references, implementations, type), load the LSP tool with '
    + '`ToolSearch select:LSP` and use it before Grep.\n'
    + 'Keep Grep for literal strings, configuration keys, comments and files no server covers.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const source = JSON.parse(readFileSync(new URL('../lsp-config/claude.json', import.meta.url), 'utf8'));
  const additionalContext = reminder(source);
  if (additionalContext) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  }
}
