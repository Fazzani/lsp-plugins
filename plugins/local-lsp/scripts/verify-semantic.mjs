import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// An isolated workspace exercises the same launcher as Codex without modifying a project.
const workspace = mkdtempSync(join(tmpdir(), 'local lsp semantic '));
const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp.mjs', import.meta.url))], {
  cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
const pending = new Map();
let id = 0;
let stderr = '';
child.stderr.on('data', data => { stderr += data; });
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { throw new Error(`Non-protocol stdout: ${line}`); }
  if (pending.has(message.id)) {
    const callback = pending.get(message.id);
    pending.delete(message.id);
    message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
  }
});

function request(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${method} timed out. ${stderr.slice(-1500)}`));
    }, 90000);
    pending.set(requestId, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
}

try {
  await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'local-lsp-verification', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const { tools } = await request('tools/list', {});
  assert(tools.some(tool => tool.name === 'find_definition_at'));
  assert(!tools.some(tool => tool.name.includes('rename')));
  if (process.argv.includes('--list-tools')) {
    console.log(JSON.stringify(tools.filter(tool => ['find_definition_at', 'find_references_at', 'get_document_symbols'].includes(tool.name)), null, 2));
  } else {
    const fixtures = [
      ['typescript', 'sample.ts', 'const answer = 42;\nconsole.log(answer);\n', 2, 13],
      ['javascript', 'sample.js', 'const answer = 42;\nconsole.log(answer);\n', 2, 13],
      ['python', 'sample.py', 'answer = 42\nprint(answer)\n', 2, 7],
      ['terraform', 'sample.tf', 'variable "answer" { default = 42 }\noutput "result" { value = var.answer }\n', 2, 30],
      ['yaml', 'sample.yaml', 'defaults: &defaults\n  answer: 42\ncopy: *defaults\n', 3, 8],
      ['php', 'sample.php', '<?php\n$answer = 42;\necho $answer;\n', 3, 7],
      ['dart', 'sample.dart', 'const answer = 42;\nvoid main() { print(answer); }\n', 2, 21],
      ['csharp', 'Sample.cs', 'public class Sample {\n  public static int Answer = 42;\n  public int Read() => Answer;\n}\n', 3, 24],
    ];
    writeFileSync(join(workspace, 'package.json'), '{"private":true}');
    writeFileSync(join(workspace, 'tsconfig.json'), '{"compilerOptions":{"allowJs":true,"checkJs":true},"include":["*.ts","*.js"]}');
    writeFileSync(join(workspace, 'pubspec.yaml'), 'name: local_lsp_verification\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n');
    writeFileSync(join(workspace, 'Sample.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
    for (const [, filename, content] of fixtures) writeFileSync(join(workspace, filename), content);
    for (const [language, filename, , line, character] of fixtures) {
      const result = await request('tools/call', {
        name: 'find_definition_at', arguments: { file_path: join(workspace, filename), line, character },
      });
      assert(!result.isError, `${language}: ${JSON.stringify(result)}`);
      assert(result.structuredContent?.definitions?.length > 0, `${language}: no definition returned`);
      console.log(`${language}: definition resolved (${result.structuredContent.server_id})`);
      if (language !== 'yaml') {
        const references = await request('tools/call', {
          name: 'find_references_at', arguments: { file_path: join(workspace, filename), line, character },
        });
        assert(!references.isError, `${language}: ${JSON.stringify(references)}`);
        assert(references.structuredContent?.references?.length > 0, `${language}: no references returned`);
        console.log(`${language}: references resolved`);
      }
    }
  }
} finally {
  child.stdin.end();
  // The launcher stops its LSP process tree on EOF before deleting the fixtures.
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
