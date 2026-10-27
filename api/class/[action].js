// Vercel serverless: one function for the live-classroom endpoints (Vercel Hobby allows at most 12 functions
// per deployment). URLs are unchanged: /api/class/config, /api/class/ticket, /api/class/token.
// The handlers live in api/_lib/class/ (folders starting with "_" are not deployed as functions).
import config from '../_lib/class/config.js';
import ticket from '../_lib/class/ticket.js';
import token from '../_lib/class/token.js';

const HANDLERS = { config, ticket, token };

export default function handler(req, res) {
  const action = String(req.query?.action || '').replace(/\.js$/, '');
  const h = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
  if (!h) return res.status(404).json({ error: 'Not found' });
  return h(req, res);
}
