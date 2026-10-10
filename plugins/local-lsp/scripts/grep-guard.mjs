#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedExtensions, loadSource } from './session-start.mjs';

// No symbol navigation worth enforcing: YAML has none, Razor support is unverified.
const UNGUARDED = new Set(['.yaml', '.yml', '.razor', '.cshtml']);
// ripgrep type names accepted by Grep's `type` parameter.
const RG_TYPES = {
  cs: '.cs', csharp: '.cs', ts: '.ts', typescript: '.ts', js: '.js', javascript: '.js',
  py: '.py', python: '.py', tf: '.tf', terraform: '.tf', dart: '.dart',
};
const NON_CODE_DIRS = /(^|[\\/])(docs?|node_modules|bin|obj|dist|build|\.git)([\\/]|$)/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CUE = /^(?:(?:public|private|protected|internal|static|async|sealed|abstract|export|override)\s+)*(?:class|interface|record|struct|enum|function|def|type)\s+|^:\s*/;

/** Returns the symbol name if one Grep alternative is a code-symbol lookup, else null. */
function symbolOf(alternative) {
  let text = alternative.replace(/\\b/g, '').replace(/^\^|\$$/g, '').trim();
  const cue = CUE.test(text) || /\\\($/.test(text);
  text = text.replace(CUE, '').replace(/\\\($/, '');
  const parts = text.split(/\\?\./);
  if (!parts.every((part) => IDENTIFIER.test(part))) return undefined; // regex or literal text
  const name = parts.at(-1);
  if (name.length < 3 || /^[A-Z0-9_]+$/.test(name)) return null; // TODO, SCREAMING_SNAKE
  const symbolCase = /[a-z][A-Z]/.test(name) || /[a-z]_[a-z]/.test(name) || parts.length > 1;
  return cue || symbolCase ? name : null;
}

/** Decides whether a Grep call is a symbol lookup in files covered by an installed language server. */
export function symbolSearch(input, extensions) {
  const covered = new Set(extensions.filter((extension) => !UNGUARDED.has(extension)));
  if (covered.size === 0 || input.multiline || input['-i'] || !input.pattern) return null;
  const path = input.path ?? '';
  if (input.type) {
    if (!covered.has(RG_TYPES[input.type])) return null;
  } else if (input.glob) {
    const glob = input.glob.toLowerCase();
    if (![...covered].some((extension) => new RegExp(
      `\\.${extension.slice(1)}(?!\\w)|\\.\\{[^}]*\\b${extension.slice(1)}\\b`).test(glob))) return null;
  } else if (extname(path)) {
    if (!covered.has(extname(path).toLowerCase())) return null;
  } else if (NON_CODE_DIRS.test(path)) {
    return null;
  }
  const symbols = input.pattern.split('|').map(symbolOf);
  if (symbols.includes(undefined)) return null;
  return symbols.find(Boolean) ?? null;
}

/**
 * PreToolUse decision for Grep. Denies a symbol lookup once per session and call, so a
 * deliberate literal search succeeds when the agent repeats the identical call.
 */
export function guard(event, extensions, stateDir = join(tmpdir(), 'local-lsp-guard')) {
  const symbol = symbolSearch(event.tool_input ?? {}, extensions);
  if (!symbol) return null;
  const file = join(stateDir, `${String(event.session_id ?? 'unknown').replace(/[^\w-]/g, '_')}.json`);
  let seen = [];
  try { seen = JSON.parse(readFileSync(file, 'utf8')); } catch { /* First denial in this session. */ }
  const key = JSON.stringify(event.tool_input);
  if (seen.includes(key)) return null;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify([...seen, key]));
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `local-lsp: '${symbol}' looks like a code symbol in files covered by a language server. `
        + 'Use the LSP tool (load it with `ToolSearch select:LSP`): workspaceSymbol with query '
        + `'${symbol}' (filePath = any covered file, line 1, character 1), then findReferences / goToDefinition / `
        + 'goToImplementation / incomingCalls at the returned position. Trust its results. '
        + 'An empty result right after startup means the server is still indexing: retry the same LSP call. '
        + 'If you really need a literal text match (string, comment, log message), repeat the identical Grep call: it will be allowed.',
    },
  };
}

/**
 * PostToolUse hint for LSP. A cold server answers the first request before indexing
 * completes; the identical call succeeds once it has, so agents must not fall back to Grep.
 */
export function coldIndexHint(event) {
  if (!/No symbols found|not finished indexing/i.test(JSON.stringify(event.tool_response ?? ''))) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'local-lsp: this empty result usually means the language server is still indexing after a cold '
        + 'start. Retry the identical LSP call before falling back to Grep; large C# solutions can need several retries.',
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const event = JSON.parse(readFileSync(0, 'utf8'));
    const decision = event.hook_event_name === 'PostToolUse'
      ? coldIndexHint(event)
      : guard(event, installedExtensions(loadSource()));
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch { /* A hook failure must never block a tool call. */ }
}
