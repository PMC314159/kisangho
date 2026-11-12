import { systemPrompt, MEMORY_PROMPT } from './character.js';

const ID = 'yeji-sangho';
// The migration account stored its encrypted API key under the name "Secret".
// Read that binding directly; never retrieve or copy its value into source files.
const apiKey = env => env.ANTHROPIC_API_KEY || env.Secret;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
const rows = async stmt => (await stmt.all()).results;
class PublicError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function callClaude(env, messages, system, maxTokens, fetcher = fetch, memory = false) {
  const gateway = env.CF_ACCOUNT_ID && env.GATEWAY_ID;
  const endpoint = gateway
    ? `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CF_ACCOUNT_ID)}/${encodeURIComponent(env.GATEWAY_ID)}/anthropic/v1/messages`
    : 'https://api.anthropic.com/v1/messages';
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey(env), 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(memory ? 35000 : 65000),
    body: JSON.stringify({
      model: (memory && env.MEMORY_MODEL) || env.ANTHROPIC_MODEL || 'claude-opus-4-6',
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages
    })
  });
  if (!response.ok) {
    // Do not expose upstream bodies: they may include configuration or prompt data.
    console.error('Anthropic request failed:', response.status);
    throw new PublicError(response.status === 429
      ? 'AI 이용 한도에 잠시 걸렸어요. 조금 뒤 같은 메시지를 다시 보내 주세요.'
      : 'AI가 답변을 완성하지 못했어요. 입력은 남아 있으니 다시 시도해 주세요.', 502);
  }
  const data = await response.json();
  if (data.stop_reason !== 'end_turn') throw new PublicError('답변이 중간에 멈췄어요. 같은 메시지로 다시 시도해 주세요.', 502);
  const text = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  if (!text) throw new PublicError('빈 답변이 왔어요. 다시 시도해 주세요.', 502);
  return text;
}

async function updateMemory(db, env, state, fetcher) {
  const unsummarized = await rows(db.prepare('SELECT id, role, content, created_at FROM messages WHERE id > ? ORDER BY id').bind(state.memory_through));
  if (unsummarized.length <= 32) return { state, warning: null };
  // Keep the latest 24 messages verbatim; summarize at most 40 per call.
  const chunk = unsummarized.slice(0, Math.min(40, unsummarized.length - 24));
  try {
    const memory = await callClaude(env, [{ role: 'user', content: JSON.stringify({ previous_memory: state.memory, conversation: chunk }) }], MEMORY_PROMPT, 4000, fetcher, true);
    if (memory.length > 6500) throw new Error('Memory response exceeded limit');
    const through = chunk.at(-1).id;
    await db.batch([
      db.prepare('UPDATE conversation SET memory = ?, memory_through = ? WHERE id = ?').bind(memory, through, ID),
      db.prepare('INSERT INTO memory_revisions (through_message, content, created_at) VALUES (?, ?, ?)').bind(through, memory, Date.now())
    ]);
    return { state: { ...state, memory, memory_through: through }, warning: null };
  } catch {
    // Cursor does not advance on failure; original messages are still available.
    if (unsummarized.length > 120) throw new PublicError('장기기억 정리를 완료하지 못했어요. 기록은 보관되어 있으니 잠시 뒤 다시 시도해 주세요.', 503);
    return { state, warning: '이번 기억 정리는 다음 대화에서 다시 시도해요. 원문은 모두 저장되어 있어요.' };
  }
}

export async function chat(request, env, fetcher = fetch) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 24000) throw new PublicError('메시지가 너무 길어요.', 413);
  let input;
  try { input = JSON.parse(raw); } catch { throw new PublicError('올바른 JSON이 아니에요.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('메시지 형식이 올바르지 않아요.');
  const { requestId, mode = 'chat' } = input;
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > 4000) throw new PublicError('메시지는 1~4000자로 입력해 주세요.');
  if (!['chat', 'scene'].includes(mode)) throw new PublicError('올바른 대화 모드가 아니에요.');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new PublicError('올바른 요청 ID가 필요해요.');
  const db = env.DB;
  const completed = async () => {
    const pair = await rows(db.prepare('SELECT * FROM messages WHERE request_id = ? ORDER BY id').bind(requestId));
    if (!pair.length) return null;
    if (pair[0].content !== message || pair[0].mode !== mode) throw new PublicError('이미 사용한 요청 ID예요.', 409);
    return json({ messages: pair, replayed: true });
  };
  const prior = await completed();
  if (prior) return prior;
  if (!apiKey(env)) throw new PublicError('Cloudflare에 ANTHROPIC_API_KEY를 설정해 주세요.', 503);
  // Atomic lease across Worker instances; two devices cannot overwrite each other.
  const owner = crypto.randomUUID();
  const now = Date.now();
  const acquired = await db.prepare('UPDATE conversation SET lock_owner = ?, lock_until = ? WHERE id = ? AND lock_until < ?')
    .bind(owner, now + 180000, ID, now).run();
  if (!acquired.meta.changes) throw new PublicError('상호가 앞선 메시지에 답하는 중이에요. 잠시 뒤 다시 보내 주세요.', 409);
  try {
    const duplicate = await completed();
    if (duplicate) return duplicate;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const cap = Math.max(1, Math.min(5000, Number(env.DAILY_MESSAGE_LIMIT) || 200));
    await db.prepare('INSERT OR IGNORE INTO usage_days (day) VALUES (?)').bind(day).run();
    const counted = await db.prepare('UPDATE usage_days SET attempts = attempts + 1 WHERE day = ? AND attempts < ?').bind(day, cap).run();
    if (!counted.meta.changes) throw new PublicError('오늘의 메시지 한도에 도달했어요. 한국 시간 자정 이후 다시 이야기할 수 있어요.', 429);
    let state = await db.prepare('SELECT * FROM conversation WHERE id = ?').bind(ID).first();
    const updated = await updateMemory(db, env, state, fetcher);
    state = updated.state;
    // Include ALL not-yet-summarized messages; no gap after a failed summary.
    const history = await rows(db.prepare('SELECT role, content FROM messages WHERE id > ? ORDER BY id').bind(state.memory_through));
    const reply = await callClaude(env, [...history, { role: 'user', content: message }], systemPrompt(mode, state.memory, now), mode === 'scene' ? 2400 : 1000, fetcher);
    const created = Date.now();
    // Pair commit is atomic. An API failure never creates a dangling user message.
    await db.batch([
      db.prepare('INSERT INTO messages (request_id, role, content, mode, created_at) VALUES (?, ?, ?, ?, ?)').bind(requestId, 'user', message, mode, now),
      db.prepare('INSERT INTO messages (request_id, role, content, mode, created_at) VALUES (?, ?, ?, ?, ?)').bind(requestId, 'assistant', reply, mode, created)
    ]);
    const saved = await rows(db.prepare('SELECT * FROM messages WHERE request_id = ? ORDER BY id').bind(requestId));
    return json({ messages: saved, warning: updated.warning });
  } finally {
    await db.prepare('UPDATE conversation SET lock_owner = NULL, lock_until = 0 WHERE id = ? AND lock_owner = ?').bind(ID, owner).run();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.WORKER_SHARED_SECRET || request.headers.get('Authorization') !== `Bearer ${env.WORKER_SHARED_SECRET}`) return json({ error: '인증되지 않은 서버 요청이에요.' }, 401);
    if (!env.DB) return json({ error: 'Cloudflare D1 DB 연결이 필요해요.' }, 503);
    try {
      if (url.pathname === '/api/chat' && request.method === 'POST') return await chat(request, env);
      if (url.pathname === '/api/reset' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { throw new PublicError('초기화 확인이 필요해요.'); }
        if (body?.confirm !== 'RESET_ALL') throw new PublicError('초기화 확인이 필요해요.');
        const owner = crypto.randomUUID();
        const now = Date.now();
        const acquired = await env.DB.prepare('UPDATE conversation SET lock_owner = ?, lock_until = ? WHERE id = ? AND lock_until < ?')
          .bind(owner, now + 180000, ID, now).run();
        if (!acquired.meta.changes) throw new PublicError('상호가 답하는 중이에요. 답장이 끝난 뒤 초기화해 주세요.', 409);
        const resetToken = crypto.randomUUID();
        try {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM messages'),
            env.DB.prepare('DELETE FROM memory_revisions'),
            env.DB.prepare('UPDATE conversation SET memory = ?, memory_through = 0, reset_token = ? WHERE id = ? AND lock_owner = ?').bind('', resetToken, ID, owner)
          ]);
          return json({ ok: true, resetToken });
        } finally {
          await env.DB.prepare('UPDATE conversation SET lock_owner = NULL, lock_until = 0 WHERE id = ? AND lock_owner = ?').bind(ID, owner).run();
        }
      }
      if (url.pathname === '/api/status' && request.method === 'GET') {
        const state = await env.DB.prepare('SELECT memory_through FROM conversation WHERE id = ?').bind(ID).first();
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first();
        return json({ ready: Boolean(apiKey(env)), messageCount: count.count, memoryThrough: state.memory_through });
      }
      if (url.pathname === '/api/history' && request.method === 'GET') {
        const beforeRaw = url.searchParams.get('before');
        const before = beforeRaw === null ? Number.MAX_SAFE_INTEGER : Number(beforeRaw);
        if (!Number.isSafeInteger(before) || before < 1) throw new PublicError('올바른 대화 위치가 아니에요.');
        const priorState = await env.DB.prepare('SELECT reset_token FROM conversation WHERE id = ?').bind(ID).first();
        const list = await rows(env.DB.prepare('SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT 61').bind(before));
        const state = await env.DB.prepare('SELECT reset_token FROM conversation WHERE id = ?').bind(ID).first();
        // A reset between these reads must never label old messages with a new token.
        if (priorState.reset_token !== state.reset_token) return json({ messages: [], hasMore: false, resetToken: state.reset_token });
        const more = list.length > 60;
        return json({ messages: list.slice(0, 60).reverse(), hasMore: more, resetToken: state.reset_token });
      }
      if (url.pathname === '/api/export' && request.method === 'GET') {
        // Read in bounded pages, preserving a stable upper boundary for this export.
        const boundary = (await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').first()).id;
        const state = await env.DB.prepare('SELECT memory, memory_through FROM conversation WHERE id = ?').bind(ID).first();
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              controller.enqueue(encoder.encode(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), character: '기상호', ...state }).slice(0, -1) + ',"messages":['));
              let cursor = 0, first = true;
              while (true) {
                const page = await rows(env.DB.prepare('SELECT * FROM messages WHERE id > ? AND id <= ? ORDER BY id LIMIT 100').bind(cursor, boundary));
                if (!page.length) break;
                for (const message of page) {
                  controller.enqueue(encoder.encode((first ? '' : ',') + JSON.stringify(message)));
                  first = false;
                }
                cursor = page.at(-1).id;
              }
              controller.enqueue(encoder.encode(']}'));
              controller.close();
            } catch (error) { controller.error(error); }
          }
        });
        return new Response(stream, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      return json({ error: '없는 주소예요.' }, 404);
    } catch (error) {
      if (error instanceof PublicError) return json({ error: error.message }, error.status);
      console.error('Worker operation failed:', error.name);
      return json({ error: '대화 서버에서 오류가 났어요. D1 마이그레이션과 서버 설정을 확인해 주세요.' }, 500);
    }
  }
};
