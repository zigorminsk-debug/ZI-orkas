'use strict';

// Exercise the real HTTP stream, including a server which sends headers but no data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zi-stream-test-'));
process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'data');
require('tsx/cjs');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { isPackaged: false, getPath: () => root, getVersion: () => '', on: () => {} }, shell: {}, BrowserWindow: {} };
  return originalLoad.call(this, name, ...args);
};
const { callZiCommanderNodeStreamForTest, createZiCommanderProvider, interleaveZiCommanderCandidatesForTest, getZiCommanderHealthForTest } = require('../src/main/model/autonomous-commander.ts');
Module._load = originalLoad;

const nodeFor = url => ({ id: 'test', model: 'test', chatUrl: url });
async function collect(url, options = {}) {
  const events = [];
  for await (const ev of callZiCommanderNodeStreamForTest(nodeFor(url), { stream: true }, {
    firstByteTimeoutMs: 180, promptBridgeActive: false, allowedToolNames: new Set(), omittedImages: 0, ...options,
  })) events.push(ev);
  return events;
}
async function serverFor(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/chat` };
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('stalled SSE headers and keep-alives time out rather than hanging', async () => {
  const { server, url } = await serverFor((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 30);
    res.on('close', () => clearInterval(timer));
  });
  try {
    await assert.rejects(collect(url), /abort|timeout/i);
  } finally { await close(server); }
});

test('a stalled stream after partial output also times out', async () => {
  const { server, url } = await serverFor((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
  });
  try { await assert.rejects(collect(url), /abort|timeout/i); }
  finally { await close(server); }
});

test('stalled non-streaming response body times out after headers', async () => {
  const { server, url } = await serverFor((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  try { await assert.rejects(collect(url), /abort|timeout/i); }
  finally { await close(server); }
});

test('real output extends the idle deadline and completes normally', async () => {
  const { server, url } = await serverFor((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = ['one', 'two', 'three'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
      else { clearInterval(timer); res.end('data: [DONE]\n\n'); }
    }, 90);
    res.on('close', () => clearInterval(timer));
  });
  try {
    const events = await collect(url);
    assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'onetwothree');
    assert.equal(events.at(-1).type, 'message_end');
  } finally { await close(server); }
});

test('stream output uses the longer idle timeout once response starts', async () => {
  const { server, url } = await serverFor((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`);
    const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 260);
    res.on('close', () => clearTimeout(timer));
  });
  try {
    const events = await collect(url, { firstByteTimeoutMs: 180, idleTimeoutMs: 500 });
    assert.equal(events.at(-1).type, 'message_end');
  } finally { await close(server); }
});

test('Auto bounds remote retries and gives an honest failure when none work', async () => {
  const oldFetch = global.fetch, oldNow = Date.now;
  let clock = 10_000_000, remoteAttempts = 0;
  Date.now = () => clock;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/models') || value.includes('supercapybara.com')) throw new Error('unavailable');
    remoteAttempts++;
    clock += 20_000;
    throw new Error('unavailable');
  };
  try {
    const provider = createZiCommanderProvider({ modelId: 'zi-commander-auto' });
    const events = [];
    for await (const event of provider.stream({ messages: [], tools: [] })) events.push(event);
    assert.equal(remoteAttempts, 3);
    assert.equal(events.at(-1).type, 'message_end');
    assert.match(events.find(e => e.type === 'text_delta').text, /ZI-Commander/);
  } finally { global.fetch = oldFetch; Date.now = oldNow; }
});

test('Auto can still fall back to a later responsive model within its budget', async () => {
  const oldFetch = global.fetch, oldNow = Date.now;
  let clock = 20_000_000, remoteAttempts = 0;
  Date.now = () => clock;
  global.fetch = async url => {
    const value = String(url);
    if (value.includes('/models') || value.includes('supercapybara.com')) throw new Error('unavailable');
    remoteAttempts++;
    clock += 10_000;
    if (remoteAttempts < 3) throw new Error('unavailable');
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  };
  try {
    const provider = createZiCommanderProvider({ modelId: 'zi-commander-auto' });
    const events = [];
    for await (const event of provider.stream({ messages: [], tools: [] })) events.push(event);
    assert.equal(remoteAttempts, 3);
    assert.equal(events.find(e => e.type === 'text_delta').text, 'ok');
  } finally { global.fetch = oldFetch; Date.now = oldNow; }
});

test('network interleaving does not skip healthy or capable nodes for cooled alternatives', () => {
  const entry = (id, network, score, inCooldown = false, isLocal = false) => ({ node: { id, network, isLocal }, score, inCooldown });
  const items = [entry('first', 'one', 1), entry('healthy', 'one', 2), entry('cooldown', 'two', 3, true)];
  assert.deepEqual(interleaveZiCommanderCandidatesForTest(items).map(e => e.node.id), ['first', 'healthy', 'cooldown']);
  assert.deepEqual(interleaveZiCommanderCandidatesForTest([entry('first','one',1), entry('capable','one',2), entry('no-tools','two',90)]).map(e => e.node.id), ['first','capable','no-tools']);
  assert.deepEqual(interleaveZiCommanderCandidatesForTest([entry('first','one',1), entry('same','one',2), entry('different','two',3)]).map(e => e.node.id), ['first','different','same']);
  assert.deepEqual(interleaveZiCommanderCandidatesForTest([entry('first','one',1), entry('local','local',2,false,true), entry('different','two',3)]).map(e => e.node.id), ['first','local','different']);
});

test('node health uses time to first output rather than full streamed answer time', async () => {
  const oldFetch = global.fetch, oldNow = Date.now;
  let clock = 30_000_000;
  Date.now = () => clock;
  global.fetch = async url => {
    if (String(url).includes('/models') || String(url).includes('supercapybara.com')) throw new Error('unavailable');
    clock += 200;
    return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const provider = createZiCommanderProvider({ modelId: 'zi-commander-auto' });
    for await (const ev of provider.stream({ messages: [], tools: [] })) {
      if (ev.type === 'text_delta') clock += 45_000;
    }
    const recorded = getZiCommanderHealthForTest().find(h => h.lastOkAt === clock);
    assert.ok(recorded);
    assert.equal(recorded.lastLatencyMs, 200);
  } finally { global.fetch = oldFetch; Date.now = oldNow; }
});

test('caller cancellation interrupts a stalled body', async () => {
  const { server, url } = await serverFor((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35);
  try { await assert.rejects(collect(url, { signal: controller.signal, firstByteTimeoutMs: 2000 }), /abort/i); }
  finally { clearTimeout(timer); await close(server); }
});

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
