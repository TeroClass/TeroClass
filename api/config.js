// Vercel serverless: public app configuration for the browser (2026-10). Only what the page may know: the Cloudflare
// Turnstile SITE key (public by design; the secret lives in Supabase Auth), whether e-mail sending is on (so the app never
// promises an e-mail that won't arrive, P-03), whether client errors are reported, and the deployment kind (staging badge).
import { resendKey } from './_lib/mail.js';
import { livekitEnv } from './_lib/livekit.js';

export function publicConfig(env = process.env) {
  const site = String(env.TURNSTILE_SITE_KEY || '').trim();
  return {
    turnstileSiteKey: /^[0-9A-Za-z_-]{8,100}$/.test(site) ? site : null,
    email: !!String(env.RESEND_API_KEY || '').trim(),
    live: livekitEnv().configured,
    errorReporting: true,
    env: env.VERCEL_ENV || 'development',
  };
}
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  return res.status(200).json(publicConfig());
}
