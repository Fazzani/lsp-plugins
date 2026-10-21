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
  py: '.py', python: '.py', php: '.php', tf: '.tf', terraform: '.tf', dart: '.dart',
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

const FLAGS_WITH_VALUE = new Set(['-A', '-B', '-C', '-m', '-f', '-M', '-j', '--max-count', '--context',
  '--after-context', '--before-context', '--file', '--max-columns', '--threads', '--color', '--colors', '--sort']);

/** Splits a shell command into words and control operators, honouring quotes. */
function tokenize(command) {
  const tokens = [];
  for (const [, doubled, single, operator, word] of command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\|\||&&|[|;\n])|([^\s"'|;&]+)/g)) {
    if (operator) tokens.push({ operator });
    else tokens.push({ word: doubled?.replace(/\\(["\\])/g, '$1') ?? single ?? word });
  }
  return tokens;
}

/**
 * Maps one grep / egrep / fgrep / rg / git grep invocation to Grep's input shape, or null.
 * ponytail: a flag-aware word parser, not a shell; unknown syntax yields null (allowed).
 */
function grepInput(words) {
  let index = 0;
  const program = words[index]?.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  if (program === 'git' && words[1] === 'grep') index = 2;
  else if (['grep', 'egrep', 'fgrep', 'rg'].includes(program)) index = 1;
  else return null;
  const input = {};
  const positional = [];
  for (; index < words.length; index += 1) {
    const word = words[index];
    const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s) : [word];
    if (flag === '-e' || flag === '--regexp') input.pattern = inline ?? words[++index];
    else if (flag === '-g' || flag === '--glob' || flag === '--include' || flag === '--iglob') input.glob = inline ?? words[++index];
    else if (flag === '-t' || flag === '--type') input.type = inline ?? words[++index];
    else if (flag === '--ignore-case' || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(flag)) input['-i'] = true;
    else if (FLAGS_WITH_VALUE.has(flag) && inline === undefined) index += 1;
    else if (flag === '--') {
      positional.push(...words.slice(index + 1));
      break;
    } else if (!word.startsWith('-')) positional.push(word);
  }
  if (input.pattern === undefined) input.pattern = positional.shift();
  if (positional.length > 0) input.path = positional[0];
  if (program !== 'rg') input.pattern = input.pattern?.replace(/\\\|/g, '|'); // BRE alternation
  return input.pattern ? input : null;
}

/** Returns the first code-symbol lookup made by grep-like programs in a shell command, else null. */
export function shellSymbolSearch(command, extensions) {
  let words = [];
  let piped = false;
  for (const token of [...tokenize(command ?? ''), { operator: ';' }]) {
    if (!token.operator) { words.push(token.word); continue; }
    const input = grepInput(words);
    // grep after a pipe without a path filters command output, not source files.
    const symbol = input && !(piped && input.path === undefined) && symbolSearch(input, extensions);
    if (symbol) return symbol;
    words = [];
    piped = token.operator === '|';
  }
  return null;
}

const stateFile = (stateDir, event) =>
  join(stateDir, `${String(event.session_id ?? 'unknown').replace(/[^\w-]/g, '_')}.json`);

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(state?.lsp) ? state : { lsp: [] };
  } catch {
    return { lsp: [] }; // No LSP lookup yet in this session.
  }
}

/** PostToolUse on LSP: remembers the names queried, which unlocks a later text search for them. */
export function recordLspQuery(event, stateDir = join(tmpdir(), 'local-lsp-guard')) {
  const query = String(event.tool_input?.query ?? '').trim().toLowerCase();
  if (!query) return;
  const file = stateFile(stateDir, event);
  const state = readState(file);
  if (state.lsp.includes(query)) return;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ lsp: [...state.lsp, query] }));
}

/**
 * PreToolUse decision for Grep and shell commands. Denies a code-symbol lookup until the
 * session has queried that symbol through the LSP; repeating the same search never passes.
 */
export function guard(event, extensions, stateDir = join(tmpdir(), 'local-lsp-guard')) {
  const input = event.tool_input ?? {};
  const shell = event.tool_name === 'Bash' || event.tool_name === 'PowerShell';
  const symbol = shell ? shellSymbolSearch(input.command, extensions) : symbolSearch(input, extensions);
  if (!symbol) return null;
  const { lsp } = readState(stateFile(stateDir, event));
  if (lsp.some((query) => query.includes(symbol.toLowerCase()))) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `local-lsp: '${symbol}' looks like a code symbol in files covered by a language server. `
        + 'Use the LSP tool (load it with `ToolSearch select:LSP`): workspaceSymbol with query '
        + `'${symbol}' (filePath = any covered file, line 1, character 1), then findReferences / goToDefinition / `
        + 'goToImplementation / incomingCalls at the returned position. Trust its results. '
        + 'An empty result right after startup means the server is still indexing: retry the same LSP call. '
        + 'Repeating this search, or running it through grep/rg in a shell, is denied too. Once workspaceSymbol has '
        + `been called for '${symbol}', a text search for it (strings, comments, log messages) is allowed.`,
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
    if (event.hook_event_name === 'PostToolUse') recordLspQuery(event);
    const decision = event.hook_event_name === 'PostToolUse'
      ? coldIndexHint(event)
      : guard(event, installedExtensions(loadSource()));
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch { /* A hook failure must never block a tool call. */ }
}
