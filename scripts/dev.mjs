import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import handler from '../api/[action].js';

const publicRoot = new URL('../public/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
createServer(async (req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 24000) return res.status(413).json({ error: '메시지가 너무 길어요.' });
        chunks.push(chunk);
      }
      req.body = Buffer.concat(chunks).toString();
    }
    return handler(req, res);
  }
  try {
    const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\//, '');
    const file = new URL(name, publicRoot);
    if (!file.href.startsWith(publicRoot.href)) throw new Error('Forbidden');
    const extension = fileURLToPath(file).match(/\.[^.]+$/)?.[0];
    const body = await readFile(file);
    res.setHeader('Content-Type', types[extension] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end('Not found'); }
}).listen(3000, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:3000'));
