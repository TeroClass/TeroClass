// Vercel serverless: health check for uptime monitoring (TC-12, 2026-10). GET /api/health → 200 when the app can reach
// Supabase, 503 otherwise. Only booleans: never URLs, keys or user data. Point Better Stack / UptimeRobot here (README).
import { SUPABASE_URL, SUPABASE_KEY, livekitEnv } from './_lib/livekit.js';
import { serviceKey } from './_lib/billing.js';
import { resendKey } from './_lib/mail.js';

async function supabaseUp(ms = 3000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_KEY }, signal: controller.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const db = await supabaseUp();
  const body = {
    ok: db, time: new Date().toISOString(), env: process.env.VERCEL_ENV || 'development',
    version: String(process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    checks: {
      supabase: db,
      ai_configured: !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY),
      token_limits: !!serviceKey(),
      email_configured: !!resendKey(),
      live_configured: livekitEnv().configured,
      captcha_configured: !!String(process.env.TURNSTILE_SITE_KEY || '').trim(),
      error_reporting: !!String(process.env.SENTRY_DSN || '').trim(),
    },
  };
  return res.status(db ? 200 : 503).json(body);
}
