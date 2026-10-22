// Minimal language server for lsp-share tests. It answers with its pid and the number of
// initialize requests it received, and publishes each document's full text as a diagnostic.
// FAKE_LSP_NOISE prints a non-LSP banner, FAKE_LSP_INIT_DELAY delays initialize (ms) and
// FAKE_LSP_IGNORE_EXIT keeps the process alive after exit, as a stuck server would.
import { createParser, frame } from '../../scripts/lsp-share.mjs';

if (process.env.FAKE_LSP_NOISE) process.stdout.write('Checking Dart SDK version...\r\n\r\n');
if (process.env.FAKE_LSP_IGNORE_EXIT) setInterval(() => {}, 60000);

const parse = createParser();
const send = (message) => process.stdout.write(frame(message));
const documents = new Map();
const waiting = new Map();
let initializeCount = 0;
let nextId = 0;

const publish = (uri) => send({
  method: 'textDocument/publishDiagnostics',
  params: { uri, diagnostics: [{ message: documents.get(uri), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] },
});

process.stdin.on('data', (chunk) => {
  for (const { id, method, params, result } of parse(chunk)) {
    if (method === undefined) {
      waiting.get(id)?.(result);
      continue;
    }
    switch (method) {
      case 'initialize':
        initializeCount += 1;
        setTimeout(() => send({ id, result: { capabilities: { textDocumentSync: 2 }, serverInfo: { name: 'fake', version: String(process.pid) } } }),
          Number(process.env.FAKE_LSP_INIT_DELAY) || 0);
        break;
      case 'test/echo':
        send({ id, result: { pid: process.pid, initializeCount, params, open: [...documents.keys()], text: documents.get(params?.textDocument?.uri) } });
        break;
      case 'test/askConfig': {
        const requestId = ++nextId;
        waiting.set(requestId, (answer) => send({ id, result: answer }));
        send({ id: requestId, method: 'workspace/configuration', params: { items: [{ section: 'fake' }] } });
        break;
      }
      case 'textDocument/didOpen':
        documents.set(params.textDocument.uri, params.textDocument.text);
        publish(params.textDocument.uri);
        break;
      case 'textDocument/didChange':
        documents.set(params.textDocument.uri, params.contentChanges.at(-1).text);
        publish(params.textDocument.uri);
        break;
      case 'textDocument/didClose':
        documents.delete(params.textDocument.uri);
        break;
      case 'shutdown':
        send({ id, result: null });
        break;
      case 'exit':
        if (!process.env.FAKE_LSP_IGNORE_EXIT) process.exit(0);
    }
  }
});
