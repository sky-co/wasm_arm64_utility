import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createToolServer } from './server.mjs';

test('toolbox integration with installed command-line tools', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'wasm-toolbox-test-'));
  const app = await createToolServer();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  });
  async function api(action, data, status = 200, headers = {}) {
    const response = await fetch(`${base}/api/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  let wasm;
  await t.test('HTML is served and external origins are rejected', async () => {
    const response = await fetch(`${base}/wasm_interpreter.html`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal([...html.matchAll(/<section(?:\s[^>]*)?>/g)].length, 7);
    assert.doesNotMatch(html, /wasm-worker|runtime-output/);
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /\p{Script=Han}/u);
    assert.match((await api('load', {}, 404)).error, /API endpoint not found/);
    const result = await api('assemble', { instruction: 'sub sp, sp, #0x10' }, 403,
      { Origin: 'https://example.com' });
    assert.match(result.error, /same-origin/);
    await new Promise((resolve, reject) => {
      const request = httpRequest(base, { headers: { Host: 'attacker.example' } }, response => {
        response.resume();
        try {
          assert.equal(response.statusCode, 403);
          response.on('end', resolve);
        } catch (error) { reject(error); }
      });
      request.on('error', reject);
      request.end();
    });
  });
  await t.test('WAST conversion preserves basename and enumerates multiple modules', async () => {
    const source = path.join(folder, 'sample input.wast');
    await writeFile(source, `(module (func (export "echo") (param i32) (result i32) local.get 0))
      (assert_return (invoke "echo" (i32.const 2)) (i32.const 2))
      (module (func (export "echo64") (param i64) (result i64) local.get 0))`);
    const result = await api('convert', { source });
    assert.equal(result.jsonPath, path.join(folder, 'sample input.json'));
    assert.deepEqual(result.modules, [
      path.join(folder, 'sample input.0.wasm'), path.join(folder, 'sample input.1.wasm'),
    ]);
    assert.deepEqual(JSON.parse(await readFile(result.jsonPath)), result.manifest);
    [wasm] = result.modules;
    const loaded = await api('memory-load-source', { source });
    assert.equal(loaded.filename, 'sample input.wast');
    assert.ok(loaded.contentBase64.length > 0);
  });
  await t.test('objdump uses the selected binary and conversion accepts binary input', async () => {
    const dump = await api('objdump', { source: wasm });
    assert.match(dump.output, /echo/);
    assert.match(dump.output, /local\.get/);
    const binary = await api('convert', { source: wasm });
    assert.deepEqual(binary.modules, [wasm]);
    assert.equal(binary.jsonPath, null);
  });
  await t.test('AArch64 assembly and disassembly match the required endian formats', async () => {
    const result = await api('assemble', { instruction: 'sub\tsp, sp, #0x10' });
    assert.equal(result.bytes, 'FF 43 00 D1');
    assert.equal(result.word, '0xD10043FFU');
    assert.equal((await api('assemble', { instruction: 'nop' })).word, '0xD503201FU');
    for (const code of [result.word, 'd10043ff']) {
      const decoded = await api('disassemble', { code });
      assert.equal(decoded.bytes, 'FF 43 00 D1');
      assert.match(decoded.output, /sub\s+sp,\s*sp,\s*#0x10/);
    }
  });
  await t.test('remote WAST conversion and Wasm disassembly', async () => {
    const remote = createServer((request, response) => {
      if (request.url === '/remote.wast') {
        response.end('(module (func (export "answer") (result i32) i32.const 42))');
      } else if (request.url === '/remote.wasm') {
        readFile(wasm).then(bytes => response.end(bytes), error => {
          response.writeHead(500);
          response.end(error.message);
        });
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    remote.listen(0, '127.0.0.1');
    await once(remote, 'listening');
    try {
      const url = `http://127.0.0.1:${remote.address().port}`;
      const result = await api('convert', { source: `${url}/remote.wast` });
      assert.equal(path.basename(result.jsonPath), 'remote.json');
      assert.equal(result.modules.length, 1);
      const dump = await api('objdump', { source: `${url}/remote.wasm` });
      assert.match(dump.output, /echo/);
      assert.match(dump.output, /local\.get/);
      const error = await api('objdump', { source: `${url}/missing.wasm` }, 400);
      assert.match(error.error, /HTTP 404/);
    } finally {
      await new Promise(resolve => {
        remote.close(resolve);
        remote.closeIdleConnections();
      });
    }
  });
  await t.test('uploaded WAST memory layout inspection', async () => {
    const source = `(module
      (memory 1)
      (data (i32.const 0) "hello")
      (data (i32.const 16) "\\01\\02\\ff"))`;
    const result = await api('memory-layout', {
      filename: 'layout.wast',
      contentBase64: Buffer.from(source).toString('base64'),
      moduleIndex: 0,
      maxBytes: 256,
    });
    assert.deepEqual(result.modules, [{ index: 0, name: 'layout.0.wasm' }]);
    assert.equal(result.selectedModule, 0);
    assert.equal(result.memoryLayout.initialPages, 1);
    assert.equal(result.memoryLayout.previewLength, 256);
    assert.ok(result.memoryLayout.previewBytesBase64.length > 0);
    assert.equal(result.memoryLayout.segments.length, 2);
    const preview = Buffer.from(result.memoryLayout.previewBytesBase64, 'base64');
    assert.equal(preview[0], 0x68);
    assert.equal(preview[1], 0x65);
    assert.equal(preview[16], 0x01);
    assert.equal(preview[17], 0x02);
    assert.equal(preview[18], 0xff);
    assert.match(result.memoryLayout.previewHexDump, /00000000:\s+68 65 6c 6c 6f/);
    assert.match(result.memoryLayout.previewHexDump, /00000010:\s+01 02 ff/);
  });
  await t.test('module byte layout is returned when no linear memory exists', async () => {
    const source = `(module
      (func (export "id") (param i32) (result i32) local.get 0))`;
    const result = await api('memory-layout', {
      filename: 'nomem.wast',
      contentBase64: Buffer.from(source).toString('base64'),
      moduleIndex: 0,
      maxBytes: 256,
    });
    assert.equal(result.memoryLayout.initialPages, null);
    assert.equal(result.memoryLayout.previewLength, 0);
    assert.ok(result.memoryLayout.moduleSize > 0);
    assert.ok(result.memoryLayout.moduleBytesBase64.length > 0);
    assert.ok(result.memoryLayout.moduleSections.length > 0);
  });
  await t.test('reference-style module bytes remain distinct from initialized linear memory', async () => {
    const source = `(module
      (type $type0 (func (param i32)))
      (type $type1 (func))
      (func $import0 (import "sys" "print") (param i32))
      (memory $memory0 200 200)
      (export "memory" (memory $memory0))
      (export "main" (func $func1))
      (func $func1 i32.const 0 call $import0)
      (data (i32.const 0) "Hello, world\\00"))`;
    const result = await api('memory-layout', {
      filename: 'reference.wast',
      contentBase64: Buffer.from(source).toString('base64'),
      paddedLeb128: true,
    });
    const layout = result.memoryLayout;
    const bytes = Buffer.from(layout.moduleBytesBase64, 'base64');
    assert.equal(bytes.length, 127);
    assert.equal(bytes.subarray(0, 14).toString('hex'), '0061736d01000000018880808000');
    assert.equal(bytes.subarray(0x72).toString(), 'Hello, world\0');
    assert.equal(Buffer.from(layout.previewBytesBase64, 'base64').subarray(0, 13).toString(), 'Hello, world\0');
    assert.match(layout.moduleWat, /\(import "sys" "print"/);
    assert.match(layout.moduleWat, /\(memory .*200 200\)/);
    assert.match(layout.moduleWat, /Hello, world\\00/);
    const watLines = layout.moduleWat.split('\n');
    function mappedBytes(pattern) {
      const line = watLines.findIndex(text => pattern.test(text));
      assert.notEqual(line, -1, String(pattern));
      const mapping = layout.moduleSourceMap[line];
      assert.notEqual(mapping.granularity, 'section', String(pattern));
      return Buffer.concat(mapping.ranges.map(range => bytes.subarray(range.start, range.end)));
    }
    assert.equal(mappedBytes(/^  \(memory /).toString('hex'), '0101c801c801');
    assert.equal(mappedBytes(/^\s+i32\.const /).toString('hex'), '4100');
    assert.equal(mappedBytes(/^\s+call /).toString('hex'), '1000');
    const memoryExport = mappedBytes(/^  \(export "memory"/);
    const mainExport = mappedBytes(/^  \(export "main"/);
    assert.ok(memoryExport.includes(Buffer.from('memory')));
    assert.ok(!memoryExport.includes(Buffer.from('main')));
    assert.ok(mainExport.includes(Buffer.from('main')));
    assert.ok(!mainExport.includes(Buffer.from('memory')));
    let end = 8;
    for (const section of layout.moduleSections) {
      assert.equal(section.headerStart, end);
      assert.ok(section.start > section.headerStart);
      assert.equal(section.size, section.end - section.start);
      end = section.end;
    }
    assert.equal(end, bytes.length);
    const binary = await api('memory-layout', {
      filename: 'unchanged.wasm',
      contentBase64: layout.moduleBytesBase64,
      paddedLeb128: true,
    });
    assert.equal(binary.memoryLayout.moduleBytesBase64, layout.moduleBytesBase64);
  });
  await t.test('code mappings distinguish functions, locals, control instructions and large immediates', async () => {
    const result = await api('memory-layout', {
      filename: 'instructions.wat',
      contentBase64: Buffer.from(`(module
        (func (param i32) (result i32) (local i64)
          block
            local.get 0
            drop
          end
          i32.const 123456)
        (func (result i32) i32.const 7))`).toString('base64'),
    });
    const layout = result.memoryLayout;
    const bytes = Buffer.from(layout.moduleBytesBase64, 'base64');
    const selections = layout.moduleWat.split('\n').flatMap((text, line) => {
      if (!/^\s+(?:local\.get|i32\.const|block|drop|end)\b/.test(text)) return [];
      const mapping = layout.moduleSourceMap[line];
      assert.equal(mapping.granularity, 'instruction', text);
      return [Buffer.concat(mapping.ranges.map(range => bytes.subarray(range.start, range.end))).toString('hex')];
    });
    assert.deepEqual(selections, ['0240', '2000', '1a', '0b', '41c0c407', '4107']);
  });
  await t.test('invalid inputs and tool errors are visible', async () => {
    for (const code of ['0x123U', '0xD10043FF00U', 'FF 43 00 D1', 'not hex']) {
      assert.match((await api('disassemble', { code }, 400)).error, /8-digit hexadecimal/);
    }
    for (const instruction of ['.include "/etc/passwd"', 'nop\nnop', 'nop; nop']) {
      assert.match((await api('assemble', { instruction }, 400)).error, /single AArch64 instruction/);
    }
    assert.match((await api('assemble', { instruction: 'invalid x0, x1' }, 400)).error, /llvm-mc/);
    const badWast = path.join(folder, 'invalid.wast');
    await writeFile(badWast, '(module invalid)');
    assert.match((await api('convert', { source: badWast }, 400)).error, /wast2json/);
    assert.match((await api('objdump', { source: badWast }, 400)).error, /Run wast2json first/);
    const badWasm = path.join(folder, 'invalid.wasm');
    await writeFile(badWasm, 'not wasm');
    assert.match((await api('objdump', { source: badWasm }, 400)).error, /wasm-objdump/);
    assert.match((await api('memory-layout', {
      filename: 'bad.txt',
      contentBase64: Buffer.from('x').toString('base64'),
    }, 400)).error, /Upload a \.wasm, \.wast, or \.wat file/);
  });
});
