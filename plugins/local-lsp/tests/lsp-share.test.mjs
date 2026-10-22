import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyChanges, createParser, endpoint, frame, nativeServer, serverExecutable, shareKey, socketPath, staticCapabilities } from '../scripts/lsp-share.mjs';

const SHIM = fileURLToPath(new URL('../scripts/lsp-share.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));

const until = async (condition, label, timeout = 10000) => {
  for (const deadline = Date.now() + timeout; !condition();) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Starts a shim the way Claude Code does and answers server requests with its own name. */
function startClient(name, env, server = [process.execPath, FAKE]) {
  const child = spawn(process.execPath, [SHIM, ...server], { env, windowsHide: true });
  const parse = createParser();
  const pending = new Map();
  const notifications = [];
  const serverRequests = [];
  let stderr = '';
  let nextId = 0;
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.on('data', (chunk) => {
    for (const message of parse(chunk)) {
      if (message.method && message.id !== undefined) {
        serverRequests.push(message);
        child.stdin.write(frame({ id: message.id, result: [name] }));
      }
      else if (message.method) notifications.push(message);
      else pending.get(message.id)?.(message);
    }
  });
  const closed = new Promise((resolve) => { child.once('close', resolve); });
  return {
    notifications,
    serverRequests,
    closed,
    request: (method, params, id = ++nextId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} ${method} timed out. ${stderr}`)), 20000);
      pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
      child.stdin.write(frame({ id, method, params }));
    }),
    notify: (method, params) => child.stdin.write(frame({ method, params })),
    end: () => child.stdin.end(),
    kill: () => child.kill(),
  };
}

const diagnostic = (client, uri) => client.notifications
  .filter((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri)
  .at(-1)?.params.diagnostics[0].message;

test('parser handles split and batched frames', () => {
  const parse = createParser();
  const bytes = Buffer.concat([frame({ id: 1, result: 'é' }), frame({ method: 'x' })]);
  assert.deepEqual(parse(bytes.subarray(0, 10)), []);
  assert.deepEqual(parse(bytes.subarray(10)), [
    { jsonrpc: '2.0', id: 1, result: 'é' }, { jsonrpc: '2.0', method: 'x' },
  ]);
});

test('incremental changes and the shim unwrapping', () => {
  const range = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } });
  assert.equal(applyChanges('one\ntwo', [{ range: range(1, 0, 3), text: '2' }, { range: range(0, 3, 3), text: '!' }]), 'one!\n2');
  assert.equal(applyChanges('old', [{ text: 'new' }]), 'new');
  assert.deepEqual(nativeServer({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/lsp-share.mjs', 'dart', 'language-server'] }),
    { command: 'dart', args: ['language-server'] });
  assert.deepEqual(nativeServer({ command: 'dart', args: ['x'] }), { command: 'dart', args: ['x'] });
  const claude = JSON.parse(readFileSync(new URL('../lsp-config/claude.json', import.meta.url), 'utf8'));
  const copilot = JSON.parse(readFileSync(new URL('../lsp-config/servers.json', import.meta.url), 'utf8'));
  assert.equal(nativeServer(claude.dart).command, 'dart');
  assert.equal(claude.dart.requestTimeout, 180000);
  assert.equal(copilot.lspServers.dart.command, 'dart');
});

test('sessions share one server, keep their own ids and documents, and the daemon stops when idle', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'local lsp share '));
  const env = { ...process.env, LOCAL_LSP_SHARE_DIR: join(workspace, 'state'), LOCAL_LSP_SHARE_IDLE_MS: '1000' };
  const previousDir = process.env.LOCAL_LSP_SHARE_DIR;
  process.env.LOCAL_LSP_SHARE_DIR = env.LOCAL_LSP_SHARE_DIR;
  const initialize = { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, clientInfo: { name: 'test' } };
  const a = startClient('a', env);
  const b = startClient('b', env);
  try {
    const [initA, initB] = await Promise.all([a.request('initialize', initialize), b.request('initialize', initialize)]);
    assert.equal(initA.result.serverInfo.version, initB.result.serverInfo.version);
    a.notify('initialized', {});
    b.notify('initialized', {});

    const [echoA, echoB] = await Promise.all([a.request('test/echo', { from: 'a' }, 7), b.request('test/echo', { from: 'b' }, 7)]);
    assert.equal(echoA.result.params.from, 'a');
    assert.equal(echoB.result.params.from, 'b');
    assert.equal(echoA.result.pid, echoB.result.pid);
    assert.equal(echoA.result.initializeCount, 1);
    const serverPid = echoA.result.pid;

    const answer = await b.request('test/askConfig', {});
    assert(['a', 'b'].includes(answer.result[0]), 'a client answers the server request');

    const shared = pathToFileURL(join(workspace, 'shared.dart')).href;
    const own = pathToFileURL(join(workspace, 'own.dart')).href;
    a.notify('textDocument/didOpen', { textDocument: { uri: shared, languageId: 'dart', version: 1, text: 'one\ntwo' } });
    b.notify('textDocument/didOpen', { textDocument: { uri: shared, languageId: 'dart', version: 1, text: 'one\ntwo' } });
    b.notify('textDocument/didOpen', { textDocument: { uri: own, languageId: 'dart', version: 1, text: 'b only' } });
    a.notify('textDocument/didChange', {
      textDocument: { uri: shared, version: 2 },
      contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, text: '2' }],
    });
    await until(() => diagnostic(b, shared) === 'one\n2' && diagnostic(b, own) === 'b only', 'diagnostics');
    assert.equal(diagnostic(a, shared), 'one\n2');
    assert.equal(diagnostic(a, own), undefined, 'diagnostics only reach clients that opened the document');

    const [key] = readdirSync(env.LOCAL_LSP_SHARE_DIR).filter((file) => file.endsWith('.token')).map((file) => file.slice(0, -6));
    const intruder = connect(endpoint(key));
    let reply = '';
    intruder.on('data', (data) => { reply += data; }).on('error', () => {});
    intruder.write('wrong-token\n');
    await new Promise((resolve) => { intruder.once('close', resolve); });
    assert.equal(reply, '', 'a wrong token is rejected');

    assert.equal((await a.request('shutdown')).result, null);
    a.notify('exit');
    await a.closed;
    const after = await b.request('test/echo', {});
    assert.equal(after.result.pid, serverPid, 'one client leaving keeps the shared server');
    assert.deepEqual(after.result.open.sort(), [own, shared].sort(), 'documents still open in another session stay open');

    b.end();
    await b.closed;
    await until(() => !alive(serverPid), 'idle shutdown');
    assert(!existsSync(join(env.LOCAL_LSP_SHARE_DIR, `${key}.token`)));
  } finally {
    a.end();
    b.end();
    if (previousDir === undefined) delete process.env.LOCAL_LSP_SHARE_DIR;
    else process.env.LOCAL_LSP_SHARE_DIR = previousDir;
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

/** A private workspace and state directory, so each test gets its own daemon. */
function setup(extraEnv = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'local lsp share '));
  const env = { ...process.env, LOCAL_LSP_SHARE_DIR: join(workspace, 'state'), LOCAL_LSP_SHARE_IDLE_MS: '500', ...extraEnv };
  const initialize = { processId: process.pid, rootUri: pathToFileURL(workspace).href, capabilities: {}, clientInfo: { name: 'test' } };
  const uri = (file) => pathToFileURL(join(workspace, file)).href;
  /** Ends the sessions, waits for the idle daemon to stop its server, then deletes the workspace. */
  const finish = async (clients, serverPid) => {
    for (const client of clients) client.end();
    try {
      if (serverPid) await until(() => !alive(serverPid), 'server stop', 15000);
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch { /* A server still running in the workspace keeps it; the OS temp cleanup removes it. */ }
    }
  };
  return { workspace, env, initialize, uri, finish };
}
const open = (client, uri, text) => client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'dart', version: 1, text } });

test('a session that dies during initialize does not become the primary', async () => {
  const { env, initialize, finish } = setup({ FAKE_LSP_INIT_DELAY: '800' });
  const a = startClient('a', env);
  const b = startClient('b', env);
  let pid;
  try {
    a.request('initialize', initialize).catch(() => {});
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    a.kill();
    await a.closed;
    await b.request('initialize', initialize);
    b.notify('initialized', {});
    const answer = await b.request('test/askConfig', {});
    assert.deepEqual(answer.result, ['b'], 'the server request reaches the live session');
    pid = (await b.request('test/echo', {})).result.pid;
  } finally {
    await finish([a, b], pid);
  }
});

test('a later session gets the diagnostics of a document it opens unchanged', async () => {
  const { env, initialize, uri, finish } = setup();
  const a = startClient('a', env);
  const b = startClient('b', env);
  let pid;
  try {
    await a.request('initialize', initialize);
    pid = (await a.request('test/echo', {})).result.pid;
    open(a, uri('f.dart'), 'same');
    await until(() => diagnostic(a, uri('f.dart')) === 'same', 'first diagnostics');
    await b.request('initialize', initialize);
    open(b, uri('f.dart'), 'same');
    await until(() => diagnostic(b, uri('f.dart')) === 'same', 'replayed diagnostics');
  } finally {
    await finish([a, b], pid);
  }
});

test('non-LSP output from the server does not break the sessions', async () => {
  const { env, initialize, finish } = setup({ FAKE_LSP_NOISE: '1' });
  const a = startClient('a', env);
  let pid;
  try {
    assert.equal((await a.request('initialize', initialize)).result.serverInfo.name, 'fake');
    pid = (await a.request('test/echo', {})).result.pid;
  } finally {
    await finish([a], pid);
  }
});

test('position requests run against the text of the requesting session', async () => {
  const { env, initialize, uri, finish } = setup();
  const a = startClient('a', env);
  const b = startClient('b', env);
  let pid;
  try {
    await Promise.all([a.request('initialize', initialize), b.request('initialize', initialize)]);
    open(a, uri('f.dart'), 'one');
    open(b, uri('f.dart'), 'one');
    b.notify('textDocument/didChange', { textDocument: { uri: uri('f.dart'), version: 2 }, contentChanges: [{ text: 'two' }] });
    await until(() => diagnostic(b, uri('f.dart')) === 'two', 'the server holding the text of b');
    const textDocument = { uri: uri('f.dart') };
    const seenByA = await a.request('test/echo', { textDocument });
    assert.equal(seenByA.result.text, 'one');
    assert.equal((await b.request('test/echo', { textDocument })).result.text, 'two');
    pid = seenByA.result.pid;
  } finally {
    await finish([a, b], pid);
  }
});

test('Flutter dart.bat resolves to the SDK binary', () => {
  const flutter = mkdtempSync(join(tmpdir(), 'local lsp flutter '));
  try {
    const wrapper = join(flutter, 'bin', 'dart.bat');
    const binary = join(flutter, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe');
    mkdirSync(join(flutter, 'bin', 'cache', 'dart-sdk', 'bin'), { recursive: true });
    writeFileSync(wrapper, '');
    assert.equal(serverExecutable(wrapper), wrapper, 'kept while the SDK cache is missing');
    writeFileSync(binary, '');
    assert.equal(serverExecutable(wrapper), binary);
    assert.equal(serverExecutable(join(flutter, 'bin', 'other.bat')), join(flutter, 'bin', 'other.bat'));
  } finally {
    rmSync(flutter, { recursive: true, force: true });
  }
});

test('stopping a server launched through a .cmd wrapper ends the whole tree', { skip: process.platform !== 'win32' }, async () => {
  const { workspace, env, initialize, finish } = setup({ FAKE_LSP_IGNORE_EXIT: '1' });
  const wrapper = join(workspace, 'fake-server.cmd');
  writeFileSync(wrapper, `@"${process.execPath}" "${FAKE}" %*\r\n`);
  const a = startClient('a', env, [wrapper]);
  let pid;
  try {
    await a.request('initialize', initialize);
    pid = (await a.request('test/echo', {})).result.pid;
    assert.notEqual(pid, undefined);
  } finally {
    try {
      await finish([a], pid); // The server ignores exit, so only the daemon's kill fallback stops it.
    } finally {
      if (pid && alive(pid)) process.kill(pid);
    }
  }
});

test('dynamic registration is turned off in forwarded capabilities', () => {
  assert.deepEqual(staticCapabilities({ a: { dynamicRegistration: true, b: [{ dynamicRegistration: true }] }, c: 1 }),
    { a: { dynamicRegistration: false, b: [{ dynamicRegistration: false }] }, c: 1 });
});

test('the initialize result declares every capability, with nothing registered later', async () => {
  const { env, initialize, finish } = setup();
  const dynamic = { ...initialize, capabilities: { textDocument: { hover: { dynamicRegistration: true }, definition: { dynamicRegistration: true } } } };
  const a = startClient('a', env);
  const b = startClient('b', env);
  let pid;
  try {
    const [initA, initB] = await Promise.all([a.request('initialize', dynamic), b.request('initialize', dynamic)]);
    pid = (await a.request('test/echo', {})).result.pid;
    for (const { result } of [initA, initB]) {
      assert.equal(result.capabilities.hoverProvider, true);
      assert.equal(result.capabilities.definitionProvider, true);
    }
    a.notify('initialized', {});
    b.notify('initialized', {});
    await Promise.all([a.request('test/echo', {}), b.request('test/echo', {})]);
    const registrations = [...a.serverRequests, ...b.serverRequests].filter((request) => request.method === 'client/registerCapability');
    assert.deepEqual(registrations, [], 'no capability is registered after initialize');
  } finally {
    await finish([a, b], pid);
  }
});

/** The single share key of a test's state directory, once its daemon serves. */
const shareKeyOf = (env) => readdirSync(env.LOCAL_LSP_SHARE_DIR).find((file) => file.endsWith('.token')).slice(0, -6);

test('the named pipe grants access to the current user only', { skip: process.platform !== 'win32' }, async () => {
  const { env, initialize, finish } = setup();
  const a = startClient('a', env);
  let pid;
  try {
    await a.request('initialize', initialize);
    pid = (await a.request('test/echo', {})).result.pid;
    const script = [
      "$rights = [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions'",
      `$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'local-lsp-${shareKeyOf(env)}', $rights, 'None', 'None', 'None')`,
      '$pipe.Connect(5000)',
      '$full = [System.IO.Pipes.PipeAccessRights]::FullControl',
      '$rules = $pipe.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType; full = ($_.PipeAccessRights -band $full) -eq $full } }',
      '$pipe.Dispose()',
      '@{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules = @($rules) } | ConvertTo-Json -Compress -Depth 4',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const { user, rules } = JSON.parse(result.stdout);
    assert.deepEqual(rules, [{ sid: user, type: 'Allow', full: true }], 'no access for Everyone, anonymous logons or other users');
  } finally {
    await finish([a], pid);
  }
});

test('a connection that does not authenticate is closed', async () => {
  const { env, initialize, finish } = setup();
  const a = startClient('a', env);
  let pid;
  let silent;
  try {
    await a.request('initialize', initialize);
    pid = (await a.request('test/echo', {})).result.pid;
    const previousDir = process.env.LOCAL_LSP_SHARE_DIR;
    process.env.LOCAL_LSP_SHARE_DIR = env.LOCAL_LSP_SHARE_DIR;
    silent = connect(endpoint(shareKeyOf(env)));
    if (previousDir === undefined) delete process.env.LOCAL_LSP_SHARE_DIR;
    else process.env.LOCAL_LSP_SHARE_DIR = previousDir;
    silent.on('error', () => {});
    let closed = false;
    silent.once('close', () => { closed = true; });
    await until(() => closed, 'the unauthenticated connection to close', 9000);
  } finally {
    silent?.destroy();
    await finish([a], pid);
  }
});

/** The endpoint of a share key in a test's own state directory. */
function endpointIn(env, key) {
  const previousDir = process.env.LOCAL_LSP_SHARE_DIR;
  process.env.LOCAL_LSP_SHARE_DIR = env.LOCAL_LSP_SHARE_DIR;
  try {
    return endpoint(key);
  } finally {
    if (previousDir === undefined) delete process.env.LOCAL_LSP_SHARE_DIR;
    else process.env.LOCAL_LSP_SHARE_DIR = previousDir;
  }
}
const modeOf = (path) => statSync(path).mode & 0o777;

test('the state and socket directories are private, and a stale socket file is replaced', { skip: process.platform === 'win32' }, async () => {
  const { env, initialize, finish } = setup();
  mkdirSync(env.LOCAL_LSP_SHARE_DIR);
  chmodSync(env.LOCAL_LSP_SHARE_DIR, 0o755);
  const socket = endpointIn(env, shareKey(process.execPath, [FAKE], initialize));
  // A daemon killed with SIGKILL leaves its socket file behind.
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert(existsSync(socket), 'the stale socket file exists before the daemon starts');
  const a = startClient('a', env);
  let pid;
  try {
    await a.request('initialize', initialize);
    pid = (await a.request('test/echo', {})).result.pid;
    assert.equal(modeOf(env.LOCAL_LSP_SHARE_DIR), 0o700);
    assert.equal(modeOf(dirname(socket)), 0o700);
  } finally {
    await finish([a], pid);
  }
});

test('a second daemon leaves a live daemon and its socket alone', { skip: process.platform === 'win32' }, async () => {
  const { workspace, env, initialize, finish } = setup();
  const a = startClient('a', env);
  let b;
  let pid;
  try {
    await a.request('initialize', initialize);
    pid = (await a.request('test/echo', {})).result.pid;
    const key = shareKey(process.execPath, [FAKE], initialize);
    const second = spawnSync(process.execPath, [SHIM, '--daemon', key, workspace, process.execPath, FAKE], { env, timeout: 10000 });
    assert.equal(second.error, undefined, 'the second daemon exits instead of serving');
    b = startClient('b', env);
    await b.request('initialize', initialize);
    assert.equal((await b.request('test/echo', {})).result.pid, pid, 'new sessions still reach the live daemon');
  } finally {
    await finish([a, ...(b ? [b] : [])], pid);
  }
});

test('a socket path longer than sun_path falls back to a short hashed path', () => {
  const key = 'a'.repeat(24);
  assert.equal(socketPath(key, '/home/me/.cache/local-lsp/share', ['/tmp'], 501), `/home/me/.cache/local-lsp/share/${key}.sock`);
  const longDir = `/Users/${'x'.repeat(120)}/.cache/local-lsp/share`;
  const fallback = socketPath(key, longDir, ['/var/folders/ab/cdefgh/T'], 501);
  assert.match(fallback, /^\/var\/folders\/ab\/cdefgh\/T\/local-lsp-501\/[0-9a-f]{24}\.sock$/);
  assert(Buffer.byteLength(fallback) <= 103);
  assert.equal(socketPath(key, longDir, ['/var/folders/ab/cdefgh/T'], 501), fallback, 'the fallback name is stable');
  assert.notEqual(socketPath(key, `${longDir}2`, ['/tmp'], 501), socketPath(key, longDir, ['/tmp'], 501), 'state directories do not collide');
  assert.match(socketPath(key, longDir, [`/${'t'.repeat(120)}`, '/tmp'], 501), /^\/tmp\/local-lsp-501\//, 'a long $TMPDIR falls back to /tmp');
});

test('sessions work when the home directory is very long', { skip: process.platform === 'win32' }, async () => {
  const { workspace, initialize, finish } = setup();
  const home = join(workspace, 'h'.repeat(100), 'i'.repeat(100));
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, LOCAL_LSP_SHARE_IDLE_MS: '500' };
  delete env.LOCAL_LSP_SHARE_DIR;
  delete env.XDG_CACHE_HOME;
  const a = startClient('a', env);
  let pid;
  try {
    await a.request('initialize', initialize);
    pid = (await a.request('test/echo', {})).result.pid;
    const key = shareKey(process.execPath, [FAKE], initialize);
    const socket = socketPath(key, join(home, '.cache', 'local-lsp', 'share'));
    assert(!socket.startsWith(home), 'the socket is not under the long home');
    assert(statSync(socket).isSocket());
    assert.equal(modeOf(dirname(socket)), 0o700);
  } finally {
    await finish([a], pid);
  }
});

test('a server body that is not JSON is dropped and the session goes on', async () => {
  const { env, initialize, finish } = setup({ FAKE_LSP_BAD_JSON: '1' });
  const a = startClient('a', env);
  let pid;
  try {
    assert.equal((await a.request('initialize', initialize)).result.serverInfo.name, 'fake');
    pid = (await a.request('test/echo', {})).result.pid;
    const log = readFileSync(join(env.LOCAL_LSP_SHARE_DIR, `${shareKeyOf(env)}.log`), 'utf8');
    assert.match(log, /server protocol error/);
  } finally {
    await finish([a], pid);
  }
});

test('a session killed mid-request has its request cancelled and leaves the others working', async () => {
  const { env, initialize, finish } = setup();
  const a = startClient('a', env);
  const b = startClient('b', env);
  let pid;
  try {
    await Promise.all([a.request('initialize', initialize), b.request('initialize', initialize)]);
    pid = (await b.request('test/echo', {})).result.pid;
    a.request('test/slow', { ms: 3000 }).catch(() => {});
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    a.kill();
    await a.closed;
    let cancelled = [];
    for (const deadline = Date.now() + 5000; cancelled.length === 0 && Date.now() < deadline;) {
      cancelled = (await b.request('test/echo', {})).result.cancelled;
    }
    assert.equal(cancelled.length, 1, 'the dead session\'s request is cancelled on the server');
    assert.deepEqual((await b.request('test/slow', { ms: 50, from: 'b' })).result, { ms: 50, from: 'b' });
  } finally {
    await finish([a, b], pid);
  }
});

test('a server that never answers initialize fails the session and stops the daemon', async () => {
  const { env, initialize, finish } = setup({ FAKE_LSP_INIT_DELAY: '60000', LOCAL_LSP_SHARE_INIT_TIMEOUT_MS: '1000' });
  const a = startClient('a', env);
  try {
    const started = Date.now();
    const answer = await a.request('initialize', initialize);
    assert.match(answer.error?.message ?? '', /did not answer initialize/);
    assert(Date.now() - started < 10000);
    await until(() => readdirSync(env.LOCAL_LSP_SHARE_DIR).every((file) => !file.endsWith('.token')), 'the daemon to stop');
    await a.closed;
  } finally {
    await finish([a]);
  }
});
