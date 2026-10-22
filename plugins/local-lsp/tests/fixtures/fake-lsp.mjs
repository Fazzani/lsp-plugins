// Minimal language server for lsp-share tests. It answers with its pid and the number of
// initialize requests it received, and publishes each document's full text as a diagnostic.
import { createParser, frame } from '../../scripts/lsp-share.mjs';

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
        send({ id, result: { capabilities: { textDocumentSync: 2 }, serverInfo: { name: 'fake', version: String(process.pid) } } });
        break;
      case 'test/echo':
        send({ id, result: { pid: process.pid, initializeCount, params, open: [...documents.keys()] } });
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
        process.exit(0);
    }
  }
});
