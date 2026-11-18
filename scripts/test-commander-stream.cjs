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
const { callZiCommanderNodeStreamForTest } = require('../src/main/model/autonomous-commander.ts');
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
