#!/usr/bin/env node
// Keeps one warm language server per project and shares it between client sessions.
// Shim mode (launched by the client): `node lsp-share.mjs <command> <args...>`.
// It reads the client's initialize request, connects to the daemon serving the same
// server and project (starting it if needed) and pipes stdio to it. The daemon runs the
// real server, multiplexes clients onto it and exits after an idle period.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findExecutable } from './mcp.mjs';

const SELF = fileURLToPath(import.meta.url);
const MUX_VERSION = 1;
const START_TIMEOUT_MS = 15000;
const STALE_LOCK_MS = 15000;
const AUTH_TIMEOUT_MS = 5000;
const SUN_PATH_MAX = 103; // macOS sun_path holds 104 bytes with the terminating NUL (Linux: 108).

/** Returns the real server command of a config entry, unwrapping this shim when present. */
export function nativeServer({ command, args = [] }) {
  return command === 'node' && /[\\/]lsp-share\.mjs$/.test(args[0] ?? '')
    ? { command: args[1], args: args.slice(2) }
    : { command, args };
}

/** Returns a function that splits an LSP byte stream into the complete JSON messages it holds. */
export function createParser() {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    const messages = [];
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const length = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'));
      if (!length) { // Not an LSP header, such as a wrapper script's banner: skip it.
        buffer = buffer.subarray(end + 4);
        continue;
      }
      const bodyEnd = end + 4 + Number(length[1]);
      if (buffer.length < bodyEnd) break;
      const body = buffer.subarray(end + 4, bodyEnd);
      buffer = buffer.subarray(bodyEnd);
      messages.push(JSON.parse(body.toString('utf8')));
    }
    return messages;
  };
}

export function frame(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function offsetAt(text, { line, character }) {
  let offset = 0;
  for (let current = 0; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  return Math.min(offset + character, lineEnd < 0 ? text.length : lineEnd);
}

/** Applies LSP content changes to a document. Positions are UTF-16 offsets, like JS strings. */
export function applyChanges(text, changes) {
  for (const change of changes) {
    text = change.range
      ? text.slice(0, offsetAt(text, change.range.start)) + change.text + text.slice(offsetAt(text, change.range.end))
      : change.text;
  }
  return text;
}

/**
 * Turns off every `dynamicRegistration` client capability. Servers then declare all their
 * capabilities in the initialize result, which the daemon caches for every session, instead
 * of registering them later with the first session only.
 */
export function staticCapabilities(capabilities) {
  if (Array.isArray(capabilities)) return capabilities.map(staticCapabilities);
  if (capabilities === null || typeof capabilities !== 'object') return capabilities;
  return Object.fromEntries(Object.entries(capabilities).map(([name, value]) => [name,
    name === 'dynamicRegistration' ? false : staticCapabilities(value)]));
}

/**
 * Identifies the shareable server instance: the same server for the same user, project
 * and client kind. Clients with other capabilities (Claude Code vs. lspi) get their own.
 */
export function shareKey(executable, args, params = {}) {
  const { rootUri, rootPath, workspaceFolders, clientInfo, capabilities, initializationOptions } = params;
  return createHash('sha256').update(JSON.stringify([
    MUX_VERSION, userInfo().username, executable, args, rootUri ?? rootPath ?? null, workspaceFolders ?? null,
    clientInfo?.name ?? null, capabilities ?? null, initializationOptions ?? null,
  ])).digest('hex').slice(0, 24);
}

export function stateDir(env = process.env) {
  if (env.LOCAL_LSP_SHARE_DIR) return env.LOCAL_LSP_SHARE_DIR;
  return process.platform === 'win32'
    ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'local-lsp', 'share')
    : join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'local-lsp', 'share');
}

/**
 * POSIX socket path for a key: in the state directory when it fits in sun_path, otherwise a
 * short hashed name in a per-user directory under $TMPDIR, then /tmp.
 */
export function socketPath(key, dir = stateDir(), temporaryDirs = [tmpdir(), '/tmp'], uid = process.getuid?.() ?? 0) {
  const preferred = posix.join(dir, `${key}.sock`);
  if (Buffer.byteLength(preferred) <= SUN_PATH_MAX) return preferred;
  const name = `${createHash('sha256').update(preferred).digest('hex').slice(0, 24)}.sock`;
  for (const temporary of temporaryDirs) {
    const candidate = posix.join(temporary, `local-lsp-${uid}`, name);
    if (Buffer.byteLength(candidate) <= SUN_PATH_MAX) return candidate;
  }
  throw new Error(`No socket path within ${SUN_PATH_MAX} bytes for ${preferred}`);
}

export const endpoint = (key) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\local-lsp-${key}`
  : socketPath(key));

/**
 * Flutter's `bin/dart.bat` only wraps the SDK's `dart.exe`. Running the binary keeps cmd.exe
 * out of the process tree, so stopping the server cannot leave an orphaned dart.exe.
 */
export function serverExecutable(executable) {
  if (!/[\\/]bin[\\/]dart\.(bat|cmd)$/i.test(executable)) return executable;
  const binary = join(dirname(executable), 'cache', 'dart-sdk', 'bin', 'dart.exe');
  return existsSync(binary) ? binary : executable;
}

/**
 * Creates `dir` if needed and, on POSIX, makes sure only the current user can enter it.
 * Windows directories under %LOCALAPPDATA% are already private through their ACL.
 */
export function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return dir;
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.uid !== process.getuid()) {
    throw new Error(`${dir} is not a directory owned by the current user`);
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

/** POSIX: removes a socket left by a dead daemon. Resolves false when a daemon still listens on it. */
function clearStaleSocket(path) {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') rmSync(path, { force: true });
      resolve(true);
    });
  });
}

const statePath = (key, extension) => join(stateDir(), `${key}.${extension}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function spawnServer(executable, args, options) {
  // Node refuses to run .bat/.cmd without a shell; arguments come from plugin configuration only.
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(executable)) {
    const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    return spawn(quote(executable), args.map(quote), { ...options, shell: true });
  }
  return spawn(executable, args, options);
}

/**
 * Windows: Node creates named pipes with the default DACL, which grants read access to
 * Everyone and to anonymous logons. Node cannot set a security descriptor, so a short
 * PowerShell client of the pipe replaces it with one that grants access to the current
 * user only. Resolves with an error message, or '' on success.
 */
function restrictPipe(key) {
  const script = [
    "$rights = [System.IO.Pipes.PipeAccessRights]'ReadWrite, ReadPermissions, ChangePermissions'",
    `$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'local-lsp-${key}', $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)`,
    '$pipe.Connect(5000)',
    '$security = New-Object System.IO.Pipes.PipeSecurity',
    '$security.SetAccessRuleProtection($true, $false)',
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($user, 'FullControl', 'Allow')))",
    '$pipe.SetAccessControl($security)',
    '$pipe.Dispose()',
  ].join('; ');
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', (error) => resolve(error.message));
    child.once('close', (code) => resolve(code === 0 ? '' : stderr.trim() || `exit code ${code}`));
  });
}

/** Starts the daemon unless another shim holds the start lock. */
function startDaemon(key, root, executable, args) {
  const lock = statePath(key, 'lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, 'wx'));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) return;
      } catch { /* The lock was just released. */ }
      rmSync(lock, { force: true });
      continue;
    }
    // The intermediate process exits at once, so killing the client's process tree spares the daemon.
    spawn(process.execPath, [SELF, '--launch', key, root, executable, ...args],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
}

/** Connects and authenticates; rejects when no daemon accepts the current token. */
function attach(key) {
  const token = readFileSync(statePath(key, 'token'), 'utf8');
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint(key));
    let received = Buffer.alloc(0);
    const fail = (error) => { socket.destroy(); reject(error ?? new Error('Connection refused by the daemon')); };
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      socket.off('data', onData).off('error', fail).off('close', fail);
      if (received.subarray(0, newline).toString() !== 'ok') return fail();
      socket.pause();
      if (received.length > newline + 1) socket.unshift(received.subarray(newline + 1));
      resolve(socket);
    };
    socket.on('data', onData).once('error', fail).once('close', () => fail());
    socket.once('connect', () => socket.write(`${token}\n`));
  });
}

async function shim(command, args) {
  const executable = serverExecutable(findExecutable(command));
  if (process.env.LOCAL_LSP_SHARE === 'off') {
    const child = spawnServer(executable, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => { console.error(`local-lsp: ${error.message}`); process.exit(1); });
    child.once('exit', (code) => process.exit(code ?? 1));
    return;
  }
  const chunks = [];
  const parse = createParser();
  const initialize = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      chunks.push(chunk);
      const [message] = parse(chunk);
      if (!message) return;
      process.stdin.off('data', onData).off('end', onEnd);
      process.stdin.pause();
      resolve(message);
    };
    const onEnd = () => reject(new Error('stdin closed before initialize'));
    process.stdin.on('data', onData).once('end', onEnd);
  });
  if (initialize.method !== 'initialize') throw new Error(`Expected initialize, got ${initialize.method}`);
  const { rootUri } = initialize.params ?? {};
  const root = rootUri?.startsWith('file:') ? fileURLToPath(rootUri) : process.cwd();
  const key = shareKey(executable, args, initialize.params);
  privateDir(stateDir());
  const deadline = Date.now() + START_TIMEOUT_MS;
  let socket;
  for (let delay = 50; !socket; delay = Math.min(delay * 2, 500)) {
    try {
      socket = await attach(key);
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`No shared server for ${command}: ${error.message}. See ${statePath(key, 'log')}`);
      startDaemon(key, root, executable, args);
      await sleep(delay);
    }
  }
  socket.write(Buffer.concat(chunks));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.resume();
  socket.once('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
}

async function daemon(key, root, executable, args) {
  const idleMs = Number(process.env.LOCAL_LSP_SHARE_IDLE_MS) || 30 * 60 * 1000;
  const initTimeoutMs = Number(process.env.LOCAL_LSP_SHARE_INIT_TIMEOUT_MS) || 60 * 1000;
  const log = (line) => appendFileSync(statePath(key, 'log'), `${new Date().toISOString()} ${line}\n`);
  const listener = createServer();
  if (process.platform !== 'win32') {
    privateDir(dirname(endpoint(key)));
    if (!await clearStaleSocket(endpoint(key))) return; // A live daemon already serves this key.
  }
  try {
    await new Promise((resolve, reject) => { listener.once('error', reject).listen(endpoint(key), resolve); });
  } catch (error) {
    if (error.code === 'EADDRINUSE') return; // Another daemon already serves this key.
    throw error;
  }
  writeFileSync(statePath(key, 'log'), '');
  if (process.platform === 'win32') {
    // Before the token exists, so no session can authenticate on a pipe with the default DACL.
    const failure = await restrictPipe(key);
    if (failure) log(`could not restrict the pipe to the current user, the token still guards it: ${failure}`);
  }
  const token = Buffer.from(randomBytes(32).toString('hex'));
  writeFileSync(statePath(key, 'token'), token, { mode: 0o600 });
  rmSync(statePath(key, 'lock'), { force: true });
  log(`serving ${executable} ${args.join(' ')} for ${root} (pid ${process.pid})`);

  const server = spawnServer(executable, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const toServer = (message) => server.stdin.write(frame(message));
  const sockets = new Set();
  const clients = new Set(); // Initialized clients; the first one is the primary.
  const requests = new Map(); // Server-side id -> { client, id, tokens }
  const relays = new Map(); // Relay id sent to a client -> { id, method } of the server request
  const tokens = new Map(); // Daemon progress token -> { client, token }
  const documents = new Map(); // uri -> { version, text, owners: Map<client, text> }
  const diagnostics = new Map(); // uri -> last non-empty publishDiagnostics, replayed to later openers
  let nextId = 0;
  let initResult;
  let initWaiters;
  let initTimer;
  let initializedSent = false;
  let idleTimer;
  let stopping = false;

  const cleanup = () => {
    for (const extension of ['token', 'lock']) {
      rmSync(statePath(key, extension), { force: true });
    }
  };
  const killServer = () => {
    if (process.platform !== 'win32') return server.kill();
    // Kill the whole tree: a .bat server runs under cmd.exe, which server.kill() alone would orphan.
    spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  };
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    listener.close();
    for (const socket of sockets) socket.end(); // end, not destroy: pending error replies still go out.
    cleanup();
    toServer({ id: 'local-lsp-shutdown', method: 'shutdown' });
    setTimeout(killServer, 5000).unref();
  };
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (sockets.size === 0) idleTimer = setTimeout(() => stop('idle'), idleMs);
  };
  const defaultReply = (method, params) => (method === 'workspace/configuration'
    ? (params?.items ?? []).map(() => null) : null);

  const syncDocument = (uri, document, text) => {
    if (text === document.text) return;
    document.text = text;
    document.version += 1;
    toServer({ method: 'textDocument/didChange', params: { textDocument: { uri, version: document.version }, contentChanges: [{ text }] } });
  };
  const closeDocument = (client, uri) => {
    client.docs.delete(uri);
    const document = documents.get(uri);
    if (!document?.owners.delete(client)) return;
    if (document.owners.size > 0) return syncDocument(uri, document, [...document.owners.values()].at(-1));
    documents.delete(uri);
    toServer({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
  };

  const fromClient = (client, message) => {
    const { id, method, params } = message;
    if (method === undefined) { // Response to a relayed server request.
      const relay = relays.get(id);
      if (relay) {
        relays.delete(id);
        toServer({ id: relay.id, ...('error' in message ? { error: message.error } : { result: message.result }) });
      }
      return;
    }
    if (id !== undefined) {
      if (method === 'initialize') {
        if (initResult) {
          clients.add(client);
          client.send({ id, result: initResult });
        } else if (initWaiters) {
          initWaiters.push({ client, id });
        } else {
          initWaiters = [{ client, id }];
          // A server that never answers would hold every later session; give up so the next
          // session starts a fresh daemon.
          initTimer = setTimeout(() => {
            const error = { code: -32603, message: `${executable} did not answer initialize within ${initTimeoutMs} ms` };
            for (const waiter of initWaiters) waiter.client.send({ id: waiter.id, error });
            stop('initialize timed out');
          }, initTimeoutMs);
          toServer({ id: 'local-lsp-initialize', method, params: {
            ...params, processId: process.pid, capabilities: staticCapabilities(params?.capabilities),
          } });
        }
      } else if (method === 'shutdown') {
        client.send({ id, result: null }); // The server is shared: only this client leaves.
      } else {
        // Positions refer to this client's text, which another session may have replaced.
        const uri = params?.textDocument?.uri;
        const document = uri && documents.get(uri);
        if (document?.owners.has(client)) syncDocument(uri, document, document.owners.get(client));
        const serverId = ++nextId;
        const owned = [];
        const rewritten = { ...params };
        for (const field of ['workDoneToken', 'partialResultToken']) {
          if (params?.[field] === undefined) continue;
          const daemonToken = `local-lsp-${++nextId}`;
          tokens.set(daemonToken, { client, token: params[field] });
          rewritten[field] = daemonToken;
          owned.push(daemonToken);
        }
        requests.set(serverId, { client, id, tokens: owned });
        client.pending.add(serverId);
        toServer({ id: serverId, method, ...(params === undefined ? {} : { params: rewritten }) });
      }
      return;
    }
    switch (method) {
      case 'initialized':
        if (!initializedSent) toServer(message);
        initializedSent = true;
        return;
      case 'exit':
        client.socket.end();
        return;
      case '$/cancelRequest':
        for (const serverId of client.pending) {
          if (requests.get(serverId).id === params?.id) toServer({ method, params: { id: serverId } });
        }
        return;
      case 'textDocument/didOpen': {
        const { uri, languageId, text } = params.textDocument;
        client.docs.add(uri);
        const document = documents.get(uri);
        if (document) {
          document.owners.set(client, text);
          syncDocument(uri, document, text);
        } else {
          documents.set(uri, { version: 1, text, owners: new Map([[client, text]]) });
          toServer({ method, params: { textDocument: { uri, languageId, version: 1, text } } });
        }
        // The server does not republish unchanged diagnostics, so a later opener gets the last ones.
        if (diagnostics.has(uri)) client.send(diagnostics.get(uri));
        return;
      }
      case 'textDocument/didChange': {
        const { uri } = params.textDocument;
        const document = documents.get(uri);
        if (!document?.owners.has(client)) return;
        const text = applyChanges(document.owners.get(client), params.contentChanges);
        document.owners.set(client, text);
        syncDocument(uri, document, text);
        return;
      }
      case 'textDocument/didClose':
        closeDocument(client, params.textDocument.uri);
        return;
      case 'textDocument/didSave':
      case 'textDocument/willSave':
        if (documents.has(params.textDocument.uri)) toServer(message);
        return;
      default:
        toServer(message);
    }
  };

  const fromServer = (message) => {
    const { id, method, params } = message;
    if (method === undefined) {
      if (id === 'local-lsp-initialize') {
        clearTimeout(initTimer);
        const waiters = initWaiters;
        if ('error' in message) {
          for (const waiter of waiters) waiter.client.send({ id: waiter.id, error: message.error });
          stop(`initialize failed: ${JSON.stringify(message.error)}`);
          return;
        }
        initResult = message.result;
        for (const waiter of waiters) {
          clients.add(waiter.client);
          waiter.client.send({ id: waiter.id, result: initResult });
        }
        return;
      }
      if (id === 'local-lsp-shutdown') {
        toServer({ method: 'exit' });
        return;
      }
      const request = requests.get(id);
      if (!request) return;
      requests.delete(id);
      request.client.pending.delete(id);
      for (const daemonToken of request.tokens) tokens.delete(daemonToken);
      request.client.send({ ...message, id: request.id });
      return;
    }
    const [primary] = clients;
    if (id !== undefined) { // Server request: the primary client answers it.
      if (!primary) return toServer({ id, result: defaultReply(method, params) });
      const relayId = ++nextId;
      relays.set(relayId, { id, method, params, client: primary });
      primary.send({ ...message, id: relayId });
      return;
    }
    if (method === 'textDocument/publishDiagnostics') {
      if (params.diagnostics?.length) diagnostics.set(params.uri, message);
      else diagnostics.delete(params.uri);
      for (const client of clients) if (client.docs.has(params.uri)) client.send(message);
    } else if (method === '$/progress' && tokens.has(params?.token)) {
      const owner = tokens.get(params.token);
      owner.client.send({ ...message, params: { ...params, token: owner.token } });
    } else {
      primary?.send(message);
    }
  };

  const leave = (client) => {
    clients.delete(client);
    // A client that dies before the initialize result must not become the primary.
    if (initWaiters) initWaiters = initWaiters.filter((waiter) => waiter.client !== client);
    for (const uri of [...client.docs]) closeDocument(client, uri);
    for (const serverId of client.pending) {
      for (const daemonToken of requests.get(serverId).tokens) tokens.delete(daemonToken);
      requests.delete(serverId);
      toServer({ method: '$/cancelRequest', params: { id: serverId } });
    }
    for (const [relayId, relay] of relays) {
      if (relay.client !== client) continue;
      relays.delete(relayId);
      toServer({ id: relay.id, result: defaultReply(relay.method, relay.params) });
    }
  };

  listener.on('connection', (socket) => {
    clearTimeout(idleTimer);
    sockets.add(socket);
    const client = { socket, docs: new Set(), pending: new Set(), send: (message) => socket.write(frame(message)) };
    const parse = createParser();
    let preamble = Buffer.alloc(0);
    // A peer that cannot read the token must not hold a connection, nor keep the daemon alive.
    const authTimer = setTimeout(() => { if (preamble) socket.destroy(); }, AUTH_TIMEOUT_MS);
    socket.on('data', (chunk) => {
      try {
        if (preamble) {
          preamble = Buffer.concat([preamble, chunk]);
          const newline = preamble.indexOf(10);
          if (newline < 0) {
            if (preamble.length > 256) socket.destroy();
            return;
          }
          const given = preamble.subarray(0, newline);
          if (given.length !== token.length || !timingSafeEqual(given, token)) return socket.destroy();
          chunk = preamble.subarray(newline + 1);
          preamble = null;
          socket.write('ok\n');
          log('client connected');
        }
        for (const message of parse(chunk)) fromClient(client, message);
      } catch (error) {
        log(`client error: ${error.message}`);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(authTimer);
      sockets.delete(socket);
      if (!preamble) {
        leave(client);
        log('client disconnected');
      }
      if (!stopping) scheduleIdle();
    });
  });

  const parseServer = createParser();
  server.stdout.on('data', (chunk) => {
    try {
      for (const message of parseServer(chunk)) fromServer(message);
    } catch (error) {
      log(`server protocol error: ${error.message}`); // Drops one message, keeps the sessions.
    }
  });
  process.on('uncaughtException', (error) => {
    log(`daemon error: ${error.stack}`);
    killServer();
    cleanup();
    process.exit(1);
  });
  server.stderr.on('data', (chunk) => appendFileSync(statePath(key, 'log'), chunk));
  server.stdin.on('error', (error) => log(`server stdin: ${error.message}`));
  server.once('error', (error) => { log(`server failed to start: ${error.message}`); stop('server error'); process.exit(1); });
  server.once('exit', (code, signal) => {
    if (!stopping) stop(`server exited (${signal ?? code})`);
    process.exit(0);
  });
  scheduleIdle();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [mode, ...rest] = process.argv.slice(2);
  const run = mode === '--launch'
    ? async () => spawn(process.execPath, [SELF, '--daemon', ...rest], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    : mode === '--daemon' ? () => daemon(rest[0], rest[1], rest[2], rest.slice(3)) : () => shim(mode, rest);
  run().catch((error) => {
    console.error(`local-lsp: ${error.message}`);
    process.exit(1);
  });
}
