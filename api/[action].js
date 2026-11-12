const ACTIONS = new Map([
  ['status', 'GET'], ['history', 'GET'], ['chat', 'POST'], ['export', 'GET'], ['reset', 'POST']
]);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const incoming = new URL(req.url, 'http://localhost');
  const action = incoming.pathname.split('/').filter(Boolean).at(-1);
  if (!ACTIONS.has(action)) return res.status(404).json({ error: '없는 주소예요.' });
  if (req.method !== ACTIONS.get(action)) {
    res.setHeader('Allow', ACTIONS.get(action));
    return res.status(405).json({ error: '지원하지 않는 요청이에요.' });
  }
  const base = process.env.CHAT_WORKER_URL;
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) {
    return res.status(503).json({ error: '채팅 서버 연결 전이에요. Vercel에 CHAT_WORKER_URL과 WORKER_SHARED_SECRET을 설정해 주세요.', code: 'NOT_CONFIGURED' });
  }
  try {
    const target = new URL(`/api/${action}`, base);
    // Only forward the supported history cursor, never arbitrary destinations or auth.
    if (action === 'history' && incoming.searchParams.has('before')) target.searchParams.set('before', incoming.searchParams.get('before'));
    let body;
    if (req.method === 'POST') {
      if (!req.headers['content-type']?.includes('application/json')) return res.status(415).json({ error: 'JSON 요청이 필요해요.' });
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!body || Buffer.byteLength(body) > 24000) return res.status(413).json({ error: '메시지가 너무 길어요.' });
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(110000),
      redirect: 'error'
    });
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
    if (action === 'export' && upstream.ok) res.setHeader('Content-Disposition', 'attachment; filename="sangho-and-yeji.json"');
    // Stream exports so long histories don't need to be buffered in this function.
    res.statusCode = upstream.status;
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) {
      if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
  } catch {
    if (res.headersSent) return res.end();
    return res.status(502).json({ error: '채팅 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요. 같은 메시지를 재시도해도 중복 저장하지 않아요.' });
  }
}
