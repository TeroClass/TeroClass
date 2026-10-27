// Vercel serverless: one function for the e-mail/notification endpoints (Vercel Hobby allows at most 12 functions
// per deployment). URLs are unchanged: /api/notify/consent, /invite, /lead, /session.
// The handlers live in api/_lib/notify/ (folders starting with "_" are not deployed as functions).
import consent from '../_lib/notify/consent.js';
import invite from '../_lib/notify/invite.js';
import lead from '../_lib/notify/lead.js';
import session from '../_lib/notify/session.js';

const HANDLERS = { consent, invite, lead, session };

export default function handler(req, res) {
  const kind = String(req.query?.kind || '').replace(/\.js$/, '');
  const h = Object.prototype.hasOwnProperty.call(HANDLERS, kind) ? HANDLERS[kind] : null;
  if (!h) return res.status(404).json({ error: 'Not found' });
  return h(req, res);
}
