const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const converter = require('../src/converter');
const config = require('../src/config');

const root = path.join(__dirname, '..');
const quiet = { log() {}, error() {} };
function load(file, dependencies, globals = {}) {
  const scope = {
    module: { exports: {} }, Buffer, console: quiet,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    process: { env: {}, platform: 'linux', arch: 'x64', stdout: {}, stderr: {}, on() {} },
    __dirname: root,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), scope, { filename: file });
  return scope.module.exports;
}

function server() {
  const routes = new Map();
  const calls = [];
  const app = {
    use() {}, listen() {},
    get: (url, ...handlers) => routes.set(url, handlers),
    post: (url, ...handlers) => routes.set(url, handlers),
  };
  load('server.js', {
    express: Object.assign(() => app, { json: () => () => {} }),
    cors: () => () => {}, path,
    fs: { existsSync: () => true, watchFile() {}, readFileSync: () => JSON.stringify({ tokens: [{ accessToken: 'test-placeholder' }] }) },
    './src/config': { cursor: { ...config.cursor, defaultModel: 'configured-model' } },
    './src/converter': converter,
    './src/cursor-client': {
      async chat(token, prompt, model, options) {
        calls.push({ prompt, model });
        options.onDelta?.('Hello');
        return { text: 'Hello', inputTokens: 3, outputTokens: 1 };
      },
      async getModels() { return { models: [{ modelId: 'custom-model' }] }; },
    },
    // Enabling obsolete settings must not restore removed capabilities.
  }, { process: { env: { API_KEY: 'test-key', BRIDGE_TOOLS: '1', ENABLE_SHELL: '1', ENABLE_WRITE: '1' }, stdout: {}, stderr: {}, on() {} } });
  async function request(body, url = '/v1/chat/completions', authorization = 'Bearer test-key') {
    const res = {
      statusCode: 200, chunks: [], on() {}, setHeader() {}, flushHeaders() {},
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
      write(chunk) { this.chunks.push(chunk); }, end() { this.writableEnded = true; },
    };
    const handlers = routes.get(url);
    const req = { body, headers: { authorization } };
    let allowed = handlers.length === 1;
    if (!allowed) handlers[0](req, res, () => { allowed = true; });
    if (allowed) await handlers.at(-1)(req, res);
    return res;
  }
  return { request, calls };
}

test('text chat, model pass-through, default model and streaming', async () => {
  const app = server();
  for (const stream of [false, true]) {
    for (const model of ['gpt-4', 'custom-model', undefined]) {
      const res = await app.request({ messages: [{ role: 'user', content: 'Hi' }], model, stream });
      assert.equal(res.statusCode, 200);
      assert.equal(app.calls.at(-1).model, model || 'configured-model');
      if (stream) {
        assert.equal(res.chunks.at(-1), 'data: [DONE]\n\n');
        const chunks = res.chunks.slice(0, -1).map(s => JSON.parse(s.slice(6)));
        assert.ok(chunks.every(c => c.model === (model || 'configured-model')));
        assert.equal(chunks[1].choices[0].delta.content, 'Hello');
      } else assert.equal(res.body.choices[0].message.content, 'Hello');
    }
  }
});

test('tool requests and tool history are rejected before contacting upstream', async () => {
  const app = server();
  const messages = [{ role: 'user', content: 'Hi' }];
  for (const extra of [
    { tools: [{ type: 'function', function: { name: 'custom' } }] },
    { tool_choice: 'required' }, { functions: [{ name: 'custom' }] }, { function_call: 'auto' },
    { messages: [{ role: 'tool', content: 'result' }] },
    { messages: [{ role: 'assistant', tool_calls: [] }] },
    { messages: [{ role: 'assistant', function_call: { name: 'custom' } }] },
  ]) {
    for (const stream of [false, true]) {
      const res = await app.request({ messages, stream, ...extra });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error.type, 'invalid_request_error');
      assert.equal(res.chunks.length, 0);
    }
  }
  assert.equal(app.calls.length, 0);
});

test('authentication, models and neutral tool fields', async () => {
  const app = server();
  assert.equal((await app.request({}, '/v1/models', 'Bearer wrong')).statusCode, 401);
  assert.equal((await app.request({}, '/v1/models')).body.data[0].id, 'custom-model');
  const res = await app.request({ messages: [{ role: 'user', content: 'Hi' }], tools: [], tool_choice: 'none' });
  assert.equal(res.statusCode, 200);
});

function frame(message) {
  const data = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function upstream(t) {
  const requests = [];
  const intervals = new Set();
  t.after(() => { for (const timer of intervals) clearInterval(timer); });
  const api = load('src/cursor-client.js', {
    http2: {
      constants: { NGHTTP2_CANCEL: 8 },
      connect() {
        const connection = new EventEmitter();
        connection.close = connection.destroy = () => {};
        connection.request = headers => {
          const req = new EventEmitter();
          Object.assign(req, { headers, writes: [], setTimeout() {}, end() {},
            write(data) { this.writes.push(data); },
            close() { this.closed = true; }, destroy() { this.destroyed = true; },
          });
          requests.push(req);
          return req;
        };
        return connection;
      },
    },
    uuid: { v4: () => 'test-id' }, './config': config,
  }, {
    process: { env: { ENABLE_SHELL: '1', ENABLE_WRITE: '1', BRIDGE_TOOLS: '1', CONNECT_RETRY_COUNT: '0' }, platform: 'linux', arch: 'x64' },
    setInterval(fn, delay) { const timer = setInterval(fn, delay); intervals.add(timer); return timer; },
  });
  return { api, requests };
}

test('upstream framing, protocol context and text completion', async t => {
  const { api, requests } = upstream(t);
  const deltas = [];
  const promise = api.chat({ accessToken: 'test-placeholder' }, 'Hi', 'gpt-4', { stream: true, onDelta: s => deltas.push(s) });
  const req = requests[0];
  assert.equal(JSON.parse(req.writes[0].subarray(5)).runRequest.requestedModel.modelId, 'gpt-4');
  req.emit('data', frame({ execServerMessage: { id: 1, requestContextArgs: {} } }));
  assert.ok(JSON.parse(req.writes[1].subarray(5)).execClientMessage.requestContextResult);
  const data = Buffer.concat([
    frame({ interactionUpdate: { textDelta: 'Hello' } }),
    frame({ interactionUpdate: { message: { textDelta: ' world' } } }),
    frame({ interactionUpdate: { turnEnded: { inputTokens: '3', outputTokens: '2' } } }),
  ]);
  req.emit('data', data.subarray(0, 7));
  req.emit('data', data.subarray(7));
  const result = await promise;
  assert.equal(result.text, 'Hello world');
  assert.equal(result.outputTokens, 2);
  assert.deepEqual(deltas, ['Hello', ' world']);
  assert.equal(req.destroyed, true);
});

test('all upstream execution requests fail without filesystem or process access', async t => {
  const { api, requests } = upstream(t);
  for (const kind of ['readArgs', 'lsArgs', 'grepArgs', 'globArgs', 'writeArgs', 'deleteArgs', 'shellArgs', 'shellStreamArgs']) {
    const promise = api.chat({ accessToken: 'test-placeholder' }, 'Hi', 'custom-model');
    const req = requests.at(-1);
    req.emit('data', frame({ execServerMessage: { [kind]: { path: '/unused', command: 'unused' } } }));
    assert.match((await promise).error, /tool execution is not supported/);
    assert.equal(req.writes.length, 1);
    assert.equal(req.destroyed, true);
  }
});

test('upstream errors and cancellation finish requests', async t => {
  const { api, requests } = upstream(t);
  const error = api.chat({ accessToken: 'test-placeholder' }, 'Hi', 'model');
  requests.at(-1).emit('data', frame({ error: { message: 'upstream failed' } }));
  assert.equal((await error).error, 'upstream failed');
  const controller = new AbortController();
  const cancelled = api.chat({ accessToken: 'test-placeholder' }, 'Hi', 'model', { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /Request aborted/);
  assert.equal(requests.at(-1).destroyed, true);
});
