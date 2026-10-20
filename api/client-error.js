// Vercel serverless: lightweight error reporting from the browser (TC-12, 2026-10).
//   POST /api/client-error {message, stack?, source?, line?, col?, url?, kind?, release?}
// Always: one structured line in the Vercel logs (searchable; a log drain can forward it). Optional: when SENTRY_DSN is set
// the event is also forwarded to Sentry (server side: the page loads no third-party script). Rate-limited per IP in
// memory; texts are truncated and e-mail addresses / tokens are scrubbed before logging.
import { clientIp, ipKey, memRateHit } from './_lib/guard.js';

const MAX = { message: 500, stack: 4000, url: 300, source: 300 };
export function scrub(s, n) {
  return String(s ?? '').slice(0, n)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(access_token|refresh_token|token|apikey|t)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
export function cleanReport(b) {
  b = b && typeof b === 'object' ? b : {};
  return {
    kind: ['error', 'unhandledrejection', 'manual'].includes(b.kind) ? b.kind : 'error',
    message: scrub(b.message, MAX.message) || '(no message)', stack: scrub(b.stack, MAX.stack),
    source: scrub(b.source, MAX.source), line: Number.isFinite(b.line) ? b.line : null, col: Number.isFinite(b.col) ? b.col : null,
    url: scrub(String(b.url || '').replace(/[?#].*$/, ''), MAX.url), release: scrub(b.release, 40),
  };
}
// SENTRY_DSN = https://<key>@<host>/<project> → envelope endpoint
export function sentryTarget(dsn) {
  const m = /^https:\/\/([0-9a-f]{16,64})@([A-Za-z0-9.-]+)\/(\d+)$/.exec(String(dsn || '').trim());
  return m ? { url: `https://${m[2]}/api/${m[3]}/envelope/?sentry_key=${m[1]}&sentry_version=7`, dsn: String(dsn).trim() } : null;
}
async function toSentry(t, r, ua) {
  const event = { event_id: crypto.randomUUID().replace(/-/g, ''), timestamp: Date.now() / 1000, platform: 'javascript', level: 'error',
    environment: process.env.VERCEL_ENV || 'development', release: r.release || undefined,
    exception: { values: [{ type: r.kind, value: r.message, stacktrace: undefined }] }, request: { url: r.url, headers: { 'User-Agent': String(ua || '').slice(0, 200) } },
    extra: { stack: r.stack, source: r.source, line: r.line, col: r.col } };
  const body = `${JSON.stringify({ event_id: event.event_id, dsn: t.dsn, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
  try { await fetch(t.url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body, signal: controller.signal }); }
  catch { /* best effort */ } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = ipKey('err', clientIp(req), process.env.RATE_LIMIT_SECRET || process.env.AZURE_OPENAI_API_KEY || '');
  if (!memRateHit(key, 30, 600000)) return res.status(429).json({ ok: false });
  const r = cleanReport(req.body);
  console.error(JSON.stringify({ type: 'client_error', ...r }));
  const t = sentryTarget(process.env.SENTRY_DSN);
  if (t) await toSentry(t, r, req.headers?.['user-agent']);
  if (typeof res.end === 'function') { res.status(204); return res.end(); }
  return res.status(204).json({});
}
