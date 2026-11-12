import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import handler from '../api/[action].js';

function capture() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  res.output = () => Buffer.concat(chunks).toString();
  return res;
}
async function configured(run) {
  const previous = { url: process.env.CHAT_WORKER_URL, secret: process.env.WORKER_SHARED_SECRET, fetch: globalThis.fetch };
  process.env.CHAT_WORKER_URL = 'https://private-worker.example';
  process.env.WORKER_SHARED_SECRET = 'server-only-test-secret';
  try { await run(); }
  finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CHAT_WORKER_URL; else process.env.CHAT_WORKER_URL = previous.url;
    if (previous.secret === undefined) delete process.env.WORKER_SHARED_SECRET; else process.env.WORKER_SHARED_SECRET = previous.secret;
  }
}
const request = (url, method = 'GET', body) => ({ url, method, body, headers: { 'content-type': 'application/json' } });

test('Vercel proxy rejects unsupported routes and methods before upstream access', async () => {
  let res = capture(); await handler(request('/api/not-allowed'), res); assert.equal(res.statusCode, 404);
  res = capture(); await handler(request('/api/chat'), res); assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('proxy forwards only the history cursor and keeps server credentials out of responses', async () => configured(async () => {
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(JSON.stringify({ messages: [], hasMore: false }), { headers: { 'Content-Type': 'application/json' } });
  };
  const res = capture();
  await handler(request('/api/history?before=61&url=https://attacker.example&token=bad'), res);
  assert.equal(forwarded.url, 'https://private-worker.example/api/history?before=61');
  assert.equal(forwarded.options.headers.Authorization, 'Bearer server-only-test-secret');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.output().includes('server-only-test-secret'), false);
}));

test('proxy accepts Vercel-parsed JSON bodies and rejects oversized byte payloads', async () => configured(async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).message, '누나 왔다.');
    return new Response('{"messages":[]}');
  };
  let res = capture(); await handler(request('/api/chat', 'POST', { message: '누나 왔다.' }), res);
  assert.equal(res.statusCode, 200);
  res = capture(); await handler(request('/api/chat', 'POST', { message: '가'.repeat(9000) }), res);
  assert.equal(res.statusCode, 413);
}));

test('proxy returns a readable error on upstream connection failure', async () => configured(async () => {
  globalThis.fetch = async () => { throw new Error('private connection detail'); };
  const res = capture(); await handler(request('/api/status'), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.output().includes('private connection detail'), false);
}));
