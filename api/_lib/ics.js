// iCalendar (RFC 5545) helpers for the calendar feed (api/calendar/feed.js) and the invitation emails
// (api/_lib/notify/session.js). No dependencies. All times are written in UTC ("…Z"), so no VTIMEZONE is needed.
// Lines end with CRLF and are folded at 75 octets (UTF-8 safe); text values are escaped.

export const PRODID = '-//TeroClass//Calendar 1.0//ES';
export const UID_DOMAIN = 'teroclass.com';
const enc = new TextEncoder();

// TEXT escaping: backslash, semicolon, comma and newlines (RFC 5545 §3.3.11). Control characters are dropped.
export function icsEscape(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// 2026-10-20T21:00:00.000Z → 20261020T210000Z (null if invalid)
export function icsDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return x.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

// Fold a content line at 75 octets; continuation lines start with one space. Never splits a UTF-8 character.
export function foldLine(line) {
  if (enc.encode(line).length <= 75) return line;
  const parts = []; let cur = ''; let len = 0; let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > limit) { parts.push(cur); cur = ' '; len = 1; limit = 75; }
    cur += ch; len += n;
  }
  parts.push(cur);
  return parts.join('\r\n');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = s => UUID_RE.test(String(s || ''));

// Safe https origin for links inside events (from APP_URL or the request host).
export function appOrigin(req) {
  const env = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(env)) return env;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) return `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}`;
  return 'https://teroclass.com';
}

// One VEVENT. ev = {id, title, group_name, teacher_name, starts_at, ends_at, status, seq, updated_at}
export function eventLines(ev, { origin = 'https://teroclass.com', now = new Date(), method = '' } = {}) {
  const start = icsDate(ev.starts_at); const end = icsDate(ev.ends_at);
  if (!isUuid(ev.id) || !start || !end) return [];
  const cancelled = ev.status === 'cancelled' || method === 'CANCEL';
  const url = `${origin}/?session=${ev.id}`;
  const title = String(ev.title || ev.group_name || 'Class').slice(0, 200);
  const desc = [ev.group_name ? `Grupo / Group: ${ev.group_name}` : '', ev.teacher_name ? `Docente / Teacher: ${ev.teacher_name}` : '',
    `Entrar / Join: ${url}`].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VEVENT',
    `UID:${ev.id}@${UID_DOMAIN}`,
    `DTSTAMP:${icsDate(ev.updated_at) || icsDate(now)}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SEQUENCE:${Math.max(0, Math.min(Number.parseInt(ev.seq, 10) || 0, 100000))}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    `URL:${url}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
  ];
  return lines;
}

// Whole calendar as a string (CRLF line endings, folded). method: '' (feed / download), 'REQUEST' or 'CANCEL'.
export function buildCalendar(events, { name = 'TeroClass', method = '', origin, now } = {}) {
  const head = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN'];
  if (method) head.push(`METHOD:${method}`);
  head.push(`X-WR-CALNAME:${icsEscape(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H');
  const body = (events || []).flatMap(ev => eventLines(ev, { origin, now, method }));
  return [...head, ...body, 'END:VCALENDAR'].map(foldLine).join('\r\n') + '\r\n';
}
