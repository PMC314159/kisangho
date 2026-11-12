import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(js|mjs)$/.test(path) ? [path] : [];
  });
}
for (const file of ['public', 'api', 'worker/src', 'scripts', 'tests'].flatMap(walk)) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
JSON.parse(readFileSync('vercel.json', 'utf8'));
const publicCode = ['public/app.js', 'public/index.html'].map(path => readFileSync(path, 'utf8')).join('\n');
if (/sk-ant-|Bearer |ANTHROPIC_API_KEY\s*=/.test(publicCode)) throw new Error('Unexpected secret in public assets');
console.log('JavaScript syntax, Vercel config and public asset checks passed.');
