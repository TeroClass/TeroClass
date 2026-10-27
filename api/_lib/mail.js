// E-mail helpers shared by api/notify/*.js (TC-08, 2026-10). Nothing is ever sent without RESEND_API_KEY, and nothing is
// sent before the database grants the sender's quota (email_quota_take, called with the SENDER's own session): at most
// 100 recipients per send and, per person and day, 30 sends / 300 recipients (staff) — so a compromised or malicious
// account cannot turn @teroclass.com into a spam relay. If the quota can't be checked, nothing is sent (fail closed).
import { SUPABASE_URL, SUPABASE_KEY } from './livekit.js';

const TIMEOUT_MS = 10000;
export function resendKey() { return String(process.env.RESEND_API_KEY || '').trim() || null; }
export const EMAIL_RE = /^[^\s@<>"',;()]{1,64}@[^\s@<>"',;()]{1,190}\.[A-Za-z]{2,24}$/;
export const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function timedFetch(url, opts, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...opts, signal: controller.signal }); } finally { clearTimeout(timer); }
}

// A user-provided text that goes into a SUBJECT: one line, no links / e-mail addresses / phishing bait, short.
export function safeSubjectText(s, max = 60) {
  let t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(/\S+@\S+/g, ' ').replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|info|biz|xyz|link|click|ly|me|app|uy|es|ar|br)\b\S*/gi, ' ');
  t = t.replace(/[<>"`$]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1).trim() + '…';
  return t;
}

// {allowed, reason?} from the database with the sender's session. null = could not check (→ send nothing).
export async function takeQuota(token, kind, recipients) {
  try {
    const r = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/email_quota_take`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_kind: kind, p_recipients: recipients }),
    });
    if (!r.ok) { console.error(`mail: email_quota_take failed (HTTP ${r.status}) — run the new 001_base.sql`); return null; }
    const d = await r.json().catch(() => null);
    return d && typeof d.allowed === 'boolean' ? d : null;
  } catch { console.error('mail: email_quota_take failed (timeout/network)'); return null; }
}

// Resend: one call per e-mail (or the batch endpoint for many). Returns {sent, failed}.
export async function sendEmails(key, emails) {
  let sent = 0; let failed = 0;
  if (emails.length === 1) {
    try {
      const r = await timedFetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(emails[0]) });
      if (r.ok) sent = 1; else { failed = 1; console.error(`mail: resend failed (HTTP ${r.status})`); }
    } catch { failed = 1; console.error('mail: resend failed (network)'); }
    return { sent, failed };
  }
  for (let i = 0; i < emails.length; i += 100) {             // Resend batch: up to 100 emails per call
    const chunk = emails.slice(i, i + 100);
    try {
      const r = await timedFetch('https://api.resend.com/emails/batch', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chunk),
      });
      if (r.ok) sent += chunk.length; else { failed += chunk.length; console.error(`mail: resend batch failed (HTTP ${r.status})`); }
    } catch { failed += chunk.length; console.error('mail: resend batch failed (network)'); }
  }
  return { sent, failed };
}
export const fromAddress = () => String(process.env.NOTIFY_FROM || 'TeroClass <no-reply@teroclass.com>').slice(0, 200);
