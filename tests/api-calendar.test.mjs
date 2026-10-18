// Unit tests for the calendar feed (ICS validity) and the email notifications in no-op mode (no network:
// fetch is mocked). Usage: node --no-warnings --test tests/api-calendar.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const ics = await import('../api/_lib/ics.js');
const feedMod = await import('../api/calendar/feed.js');
const notifyMod = await import('../api/notify/session.js');

const TOKEN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '66666666-7777-4888-9999-000000000000';
const ROWS = [
  { id: S1, title: 'English B1; review, part 1 \\ final', group_name: 'English B1 – Tue/Thu', teacher_name: 'Ana Pérez',
    starts_at: '2026-10-20T21:00:00+00:00', ends_at: '2026-10-20T22:30:00+00:00', status: 'scheduled', seq: 2, updated_at: '2026-10-18T12:00:00Z', role: 'student' },
  { id: S2, title: '', group_name: 'Química 3°B', teacher_name: '', starts_at: '2026-10-22T13:00:00Z', ends_at: '2026-10-22T14:00:00Z',
    status: 'cancelled', seq: 5, updated_at: '2026-10-18T12:00:00Z', role: 'teacher' },
];

function res() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.send = b => { r.body = b; return r; };
  r.end = b => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); };
  return calls;
}
const lines = s => s.split('\r\n');

test('ics: text escaping (backslash, semicolon, comma, newline) and control characters dropped', () => {
  assert.equal(ics.icsEscape('a\\b;c,d\ne\r\nf\u0007'), 'a\\\\b\\;c\\,d\\ne\\nf');
});

test('ics: dates in UTC basic format', () => {
  assert.equal(ics.icsDate('2026-10-20T18:00:00-03:00'), '20261020T210000Z');
  assert.equal(ics.icsDate('nope'), null);
});

test('ics: folding at 75 octets, UTF-8 safe, continuation starts with a space', () => {
  const long = 'DESCRIPTION:' + 'ñ'.repeat(100);
  const folded = ics.foldLine(long);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(Buffer.byteLength(p, 'utf8') <= 75, `line too long: ${Buffer.byteLength(p)}`);
  parts.slice(1).forEach(p => assert.equal(p[0], ' '));
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), long);
  assert.equal(ics.foldLine('SHORT:x'), 'SHORT:x');
});

test('ics: calendar structure, CRLF everywhere, UID, DTSTART in UTC, SEQUENCE, STATUS', () => {
  const out = ics.buildCalendar(ROWS, { origin: 'https://teroclass.com', now: new Date('2026-10-18T00:00:00Z') });
  assert.ok(out.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'bare LF found');
  const L = lines(out);
  assert.equal(L[0], 'BEGIN:VCALENDAR');
  assert.ok(L.includes('VERSION:2.0'));
  assert.ok(L.some(l => l.startsWith('PRODID:')));
  assert.equal(L.filter(l => l === 'BEGIN:VEVENT').length, 2);
  assert.equal(L.filter(l => l === 'END:VEVENT').length, 2);
  assert.ok(L.includes(`UID:${S1}@teroclass.com`) && L.includes(`UID:${S2}@teroclass.com`));
  assert.ok(L.includes('DTSTART:20261020T210000Z') && L.includes('DTEND:20261020T223000Z'));
  assert.ok(L.includes('SEQUENCE:2') && L.includes('SEQUENCE:5'));
  assert.ok(L.includes('STATUS:CONFIRMED') && L.includes('STATUS:CANCELLED'));
  assert.ok(L.includes('SUMMARY:English B1\\; review\\, part 1 \\\\ final'));
  assert.ok(L.includes('SUMMARY:Química 3°B'), 'empty title falls back to the group name');
  assert.ok(!out.includes('VTIMEZONE'), 'UTC times: no VTIMEZONE needed');
  assert.equal(L[L.length - 2], 'END:VCALENDAR');
});

test('ics: events with a bad id or dates are skipped; METHOD for invitations', () => {
  const out = ics.buildCalendar([{ id: 'x', starts_at: 'bad' }, ROWS[0]], { method: 'REQUEST' });
  assert.equal(lines(out).filter(l => l === 'BEGIN:VEVENT').length, 1);
  assert.ok(lines(out).includes('METHOD:REQUEST'));
  const cancel = ics.buildCalendar([ROWS[0]], { method: 'CANCEL' });
  assert.ok(lines(cancel).includes('METHOD:CANCEL') && lines(cancel).includes('STATUS:CANCELLED'));
});

test('feed: malformed token → 404 and the database is not called', async () => {
  const calls = mockFetch(() => new Response('[]'));
  for (const token of ['', 'abc', 'Z'.repeat(64), TOKEN + 'a']) {
    const r = res(); await feedMod.default({ method: 'GET', query: { token }, headers: {} }, r);
    assert.equal(r.statusCode, 404);
  }
  assert.equal(calls.length, 0);
});

test('feed: valid token → text/calendar from calendar_feed with the publishable key; no emails', async () => {
  const calls = mockFetch((url, opts) => {
    assert.ok(url.endsWith('/rest/v1/rpc/calendar_feed'));
    assert.deepEqual(JSON.parse(opts.body), { p_token: TOKEN });
    assert.ok(String(opts.headers.apikey).startsWith('sb_publishable_'));
    return new Response(JSON.stringify(ROWS), { status: 200 });
  });
  const r = res();
  await feedMod.default({ method: 'GET', query: { token: TOKEN.toUpperCase() + '.ics' }, headers: { host: 'tero-class.vercel.app' } }, r);
  assert.equal(calls.length, 1);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /^text\/calendar/);
  assert.ok(r.body.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(r.body.replace(/\r\n /g, '').includes(`URL:https://tero-class.vercel.app/?session=${S1}`), 'join link (unfolded)');
  assert.ok(!/[A-Za-z0-9._%+-]+@(?!teroclass\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(r.body), 'no email addresses in the feed');
  assert.match(r.headers['cache-control'], /private/);
});

test('feed: unknown token (empty list) → valid empty calendar; database error → 502', async () => {
  mockFetch(() => new Response('[]', { status: 200 }));
  let r = res(); await feedMod.default({ method: 'GET', url: `/api/calendar/feed?token=${TOKEN}`, headers: {} }, r);
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.includes('BEGIN:VCALENDAR') && !r.body.includes('BEGIN:VEVENT'));
  mockFetch(() => new Response('{"message":"boom"}', { status: 500 }));
  r = res(); await feedMod.default({ method: 'GET', query: { token: TOKEN }, headers: {} }, r);
  assert.equal(r.statusCode, 502);
  r = res(); await feedMod.default({ method: 'POST', query: { token: TOKEN }, headers: {} }, r);
  assert.equal(r.statusCode, 405);
});

test('notify: without RESEND_API_KEY it is a no-op ("email not configured"), nothing is read or sent', async () => {
  delete process.env.RESEND_API_KEY;
  const calls = mockFetch(() => new Response('{}'));
  const r = res();
  await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session_id: S1, kind: 'invite' } }, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { configured: false, sent: 0, message: 'email not configured' });
  assert.equal(calls.length, 0);
  const g = res(); await notifyMod.default({ method: 'GET', headers: {} }, g);
  assert.equal(g.statusCode, 405);
});

test('notify: with a key → auth required, payload from the database with the caller token, batch to Resend; key never echoed', async () => {
  process.env.RESEND_API_KEY = 're_test_secret_key_123';
  try {
    let r = res(); await notifyMod.default({ method: 'POST', headers: {}, body: { session_id: S1, kind: 'invite' } }, r);
    assert.equal(r.statusCode, 401);
    r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session_id: 'nope', kind: 'invite' } }, r);
    assert.equal(r.statusCode, 400);
    const payload = { ...ROWS[0], timezone: 'America/Montevideo', recipients: [{ email: 'ana@mail.com' }, { email: 'ANA@mail.com' }, { email: 'bad' }, { email: 'beto@mail.com' }] };
    const calls = mockFetch((url, opts) => {
      if (url.endsWith('/rpc/session_notify_payload')) {
        assert.equal(opts.headers.Authorization, 'Bearer good');
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url === 'https://api.resend.com/emails/batch') {
        assert.equal(opts.headers.Authorization, 'Bearer re_test_secret_key_123');
        return new Response('{"data":[]}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good', host: 'teroclass.com' }, body: { session_id: S1, kind: 'cancel', lang: 'en' } }, r);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { configured: true, sent: 2, failed: 0 });
    assert.ok(!JSON.stringify(r.body).includes('re_test'));
    const batch = JSON.parse(calls.find(c => c.url.includes('resend')).opts.body);
    assert.deepEqual(batch.map(e => e.to[0]), ['ana@mail.com', 'beto@mail.com']);
    const att = Buffer.from(batch[0].attachments[0].content, 'base64').toString('utf8');
    assert.ok(att.includes('METHOD:CANCEL') && att.includes('STATUS:CANCELLED') && att.includes(`UID:${S1}@teroclass.com`));
    assert.match(batch[0].subject, /^Class cancelled: /);
    // not the session's teacher → the database refuses
    mockFetch(() => new Response('{"message":"No autorizado"}', { status: 400 }));
    r = res(); await notifyMod.default({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { session_id: S1, kind: 'invite' } }, r);
    assert.equal(r.statusCode, 403);
  } finally { delete process.env.RESEND_API_KEY; }
});
