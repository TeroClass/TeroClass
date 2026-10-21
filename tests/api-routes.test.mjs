// Vercel Hobby allows at most 12 functions per deployment: /api/class/* and /api/notify/* are one function each.
// Usage: node --no-warnings --test tests/api-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const classFn = (await import('../api/class/[action].js')).default;
const notifyFn = (await import('../api/notify/[kind].js')).default;
function res() { const r = { statusCode: 0, body: null, headers: {} }; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; }

test('at most 12 serverless functions (Vercel Hobby limit)', () => {
  const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); if (statSync(p).isDirectory()) return n.startsWith('_') ? [] : walk(p); return n.endsWith('.js') && !n.startsWith('_') ? [p] : []; });
  const fns = walk('api');
  assert.ok(fns.length <= 12, `${fns.length} functions: ${fns.join(', ')}`);
});

test('dispatchers route known actions and 404 the rest', async () => {
  delete process.env.LIVEKIT_URL;
  let r = res(); await classFn({ method: 'GET', query: { action: 'config' }, headers: {} }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.configured, false);
  r = res(); await classFn({ method: 'GET', query: { action: 'nope' }, headers: {} }, r); assert.equal(r.statusCode, 404);
  r = res(); await classFn({ method: 'GET', query: { action: '__proto__' }, headers: {} }, r); assert.equal(r.statusCode, 404);
  r = res(); await notifyFn({ method: 'GET', query: { kind: 'session' }, headers: {} }, r); assert.notEqual(r.statusCode, 404);
  r = res(); await notifyFn({ method: 'POST', query: { kind: 'x' }, headers: {} }, r); assert.equal(r.statusCode, 404);
});
