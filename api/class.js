// Vercel serverless: one function for the live-classroom endpoints (Vercel Hobby allows at most 12 functions
// per deployment). URLs are unchanged: /api/class/config, /api/class/ticket, /api/class/token, and the recording pipeline:
// /api/class/rec (teacher pause / resume / end) and /api/class/process (daily cron + the app while a class is processing).
// The handlers live in api/_lib/class/ (folders starting with "_" are not deployed as functions).
import config from './_lib/class/config.js';
import ticket from './_lib/class/ticket.js';
import token from './_lib/class/token.js';
import rec from './_lib/class/rec.js';
import processWork from './_lib/class/process.js';

const HANDLERS = { config, ticket, token, rec, process: processWork };

export default function handler(req, res) {
  const action = String(req.query?.action || '').replace(/\.js$/, '');
  const h = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
  if (!h) return res.status(404).json({ error: 'Not found' });
  return h(req, res);
}
