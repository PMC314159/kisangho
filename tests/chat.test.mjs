import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { chat } from '../worker/src/index.js';
import { systemPrompt } from '../worker/src/character.js';

class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../worker/migrations/0001_memory.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const prepared = this.sqlite.prepare(sql);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return prepared.get(...values) || null; },
      async all() { return { results: prepared.all(...values) }; },
      async run() { const result = prepared.run(...values); return { meta: { changes: Number(result.changes) } }; }
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
function setup() {
  return { DB: new D1(), ANTHROPIC_API_KEY: 'test-key-not-real', WORKER_SHARED_SECRET: 'test-server-secret', ANTHROPIC_MODEL: 'test-model', DAILY_MESSAGE_LIMIT: '200' };
}
const request = (message = '상호야, 누나 왔다.', requestId = crypto.randomUUID(), mode = 'chat') => new Request('https://worker.test/api/chat', {
  method: 'POST', body: JSON.stringify({ message, requestId, mode })
});
const response = text => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
async function seed(env, count) {
  for (let i = 0; i < count; i++) {
    await env.DB.prepare('INSERT INTO messages (request_id, role, content, mode, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(`seed-${Math.floor(i / 2)}`, i % 2 ? 'assistant' : 'user', `과거 대화 ${i + 1}`, 'chat', 1700000000000 + i).run();
  }
}
const fetchRequest = (path, secret = 'test-server-secret') => new Request(`https://worker.test/api/${path}`, { headers: { Authorization: `Bearer ${secret}` } });

test('completed conversation persists across independent requests, devices and modes', async () => {
  const env = setup();
  await chat(request('누나는 복숭아 좋아해.'), env, async () => response('복숭아, 기억해 놓을게요.'));
  let sent;
  await chat(request('내가 어떤 과일 좋아한다고 했지?', crypto.randomUUID(), 'scene'), { ...env }, async (_url, options) => {
    sent = JSON.parse(options.body); return response('상호는 누나가 좋아한다고 말했던 복숭아를 떠올렸다.');
  });
  assert.equal(sent.messages[0].content, '누나는 복숭아 좋아해.');
  assert.equal(sent.messages.length, 3);
  assert.match(sent.system[0].text, /장면 모드/);
  const history = await (await worker.fetch(fetchRequest('history'), env)).json();
  assert.equal(history.messages.length, 4);
  assert.equal(history.messages[3].mode, 'scene');
});

test('retrying the same request ID returns the stored pair without another API call', async () => {
  const env = setup(), id = crypto.randomUUID();
  await chat(request('안녕', id), env, async () => response('누나, 왔어요?'));
  const retried = await chat(request('안녕', id), env, async () => { throw new Error('must not call'); });
  assert.equal((await retried.json()).replayed, true);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).count, 2);
  await assert.rejects(chat(request('다른 내용', id), env), { status: 409 });
});

test('migration Secret binding is used consistently for readiness and API authentication', async () => {
  const env = setup();
  delete env.ANTHROPIC_API_KEY;
  env.Secret = 'migration-test-key';
  const status = await (await worker.fetch(fetchRequest('status'), env)).json();
  assert.equal(status.ready, true);
  await chat(request('안녕하세요.'), env, async (_url, options) => {
    assert.equal(options.headers['x-api-key'], 'migration-test-key');
    return response('안녕하세요.');
  });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).count, 2);
});

test('upstream failure saves no partial pair and releases the shared lease', async () => {
  const env = setup(), id = crypto.randomUUID();
  await assert.rejects(chat(request('안녕', id), env, async () => new Response('secret error body', { status: 500 })), { status: 502 });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).count, 0);
  assert.equal((await env.DB.prepare('SELECT lock_until FROM conversation').first()).lock_until, 0);
  await chat(request('안녕', id), env, async () => response('누나, 안녕.'));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).count, 2);
});

test('two devices cannot generate replies concurrently against the same memory', async () => {
  const env = setup();
  let signalStarted, finish;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const first = chat(request('첫 번째'), env, async () => {
    signalStarted(); return new Promise(resolve => { finish = () => resolve(response('첫 답장')); });
  });
  await started;
  await assert.rejects(chat(request('두 번째'), env, async () => response('두 번째')), { status: 409 });
  finish(); await first;
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).count, 2);
});

test('long-term memory advances only after a successful summary and never deletes originals', async () => {
  const env = setup(); await seed(env, 34);
  let outgoing;
  await chat(request('오늘은 딸기도 좋아.'), env, async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.max_tokens === 4000) return response('예지는 복숭아를 좋아한다.');
    outgoing = body; return response('그것도 기억할게요.');
  });
  const state = await env.DB.prepare('SELECT * FROM conversation').first();
  assert.equal(state.memory_through, 10);
  assert.match(outgoing.system[0].text, /예지는 복숭아를 좋아한다/);
  assert.equal(outgoing.messages[0].content, '과거 대화 11');
  assert.equal(outgoing.messages.length, 25);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).count, 36);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM memory_revisions').first()).count, 1);
});

test('failed summary preserves its cursor and sends all unarchived messages, without a context gap', async () => {
  const env = setup(); await seed(env, 36);
  let outgoing;
  const result = await chat(request('기억하고 있어?'), env, async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.max_tokens === 4000) throw new Error('summary unavailable');
    outgoing = body; return response('누나랑 한 얘기 보고 있었어요.');
  });
  assert.equal((await env.DB.prepare('SELECT memory_through FROM conversation').first()).memory_through, 0);
  assert.equal(outgoing.messages.length, 37);
  assert.ok((await result.json()).warning);
});

test('history paginates without gaps and backup exports every stored message', async () => {
  const env = setup(); await seed(env, 132);
  const first = await (await worker.fetch(fetchRequest('history'), env)).json();
  assert.equal(first.messages.length, 60); assert.equal(first.hasMore, true);
  const second = await (await worker.fetch(fetchRequest(`history?before=${first.messages[0].id}`), env)).json();
  assert.equal(second.messages.at(-1).id + 1, first.messages[0].id);
  const backup = await (await worker.fetch(fetchRequest('export'), env)).json();
  assert.equal(backup.messages.length, 132); assert.equal(backup.messages[0].id, 1);
});

test('unauthenticated Worker access is rejected and daily limit persists in D1', async () => {
  const env = setup(); env.DAILY_MESSAGE_LIMIT = '1';
  assert.equal((await worker.fetch(fetchRequest('history', 'wrong'), env)).status, 401);
  await chat(request('한 번'), env, async () => response('응.'));
  await assert.rejects(chat(request('두 번'), { ...env }, async () => response('응.')), { status: 429 });
});

test('invalid input and truncated model output do not change history', async () => {
  const env = setup();
  await assert.rejects(chat(new Request('https://worker.test/api/chat', { method: 'POST', body: 'null' }), env), { status: 400 });
  await assert.rejects(chat(request(''), env), { status: 400 });
  await assert.rejects(chat(request('a'.repeat(4001)), env), { status: 400 });
  await assert.rejects(chat(request('안녕'), env, async () => new Response(JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '잘린 문장' }] }))), { status: 502 });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()).count, 0);
});

test('character prompt preserves the adult academy setting, gradual speech and Korean time', () => {
  const prompt = systemPrompt('chat', '예지는 복숭아를 좋아한다.', Date.UTC(2026, 10, 12, 15, 30));
  assert.match(prompt, /23세/); assert.match(prompt, /26세/);
  assert.match(prompt, /20~21세에 군 복무/); assert.match(prompt, /22세에 준향대학교 2학년으로 복학/);
  assert.match(prompt, /고양 농구팀/); assert.match(prompt, /성인 영어학원/);
  assert.match(prompt, /첫 호칭은 '예지님'/); assert.match(prompt, /반존대/);
  assert.match(prompt, /정해진 메시지 수나 접속 횟수로 친밀도를 올리지 않는다/);
  assert.match(systemPrompt('chat', ''), /첫 단계로 시작/);
  assert.match(prompt, /예지 누나/); assert.match(prompt, /경상도 사투리/);
  assert.match(prompt, /11월 13일/); assert.match(prompt, /예지는 복숭아를 좋아한다/);
});
