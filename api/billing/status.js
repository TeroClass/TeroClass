// Vercel serverless: tells the app whether AI token limits are active (Platform screen banner).
// Only booleans — never keys. billing_ok is checked only for a signed-in user (one cheap RPC with the
// service key: it confirms the key works and that the database script with the billing functions ran).
import { serviceKey, serviceRpc, SUPABASE_URL } from '../_lib/billing.js';

const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_D4ZATRSmyiURioJ4PvTb4A_rR_urilK';

async function signedIn(token) {
  if (!token) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }, signal: controller.signal });
    clearTimeout(timer);
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  const configured = !!serviceKey();
  let ok = null;
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (configured && await signedIn(token)) ok = (await serviceRpc('billing_service_ping', {}, { timeoutMs: 8000 })) === true;
  return res.status(200).json({ billing_configured: configured, billing_ok: ok });
}
