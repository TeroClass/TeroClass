// Recording pipeline (LiveKit Egress → Azure Blob → Azure Speech → Azure OpenAI insights): configuration.
// OFF by default. It is "configured" only when EVERY variable below is set (README → "Grabación real"):
//   RECORDING_ENABLED=true · LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET · AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY /
//   AZURE_STORAGE_CONTAINER · AZURE_SPEECH_KEY / AZURE_SPEECH_REGION · CRON_SECRET · SUPABASE_SERVICE_ROLE_KEY (the pipeline
//   writes with the server key; without it nothing could be stored).
// Only booleans ever leave the server (/api/health, /api/config): never keys, names or URLs.
import { timingSafeEqual, createHash } from 'node:crypto';

const truthy = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());
export const SPEECH_API_VERSION = '2024-11-15';
export const RETENTION_DAYS = 30;

export function recordingEnv(env = process.env) {
  const t = k => String(env[k] || '').trim();
  const livekit = { url: t('LIVEKIT_URL'), apiKey: t('LIVEKIT_API_KEY'), apiSecret: t('LIVEKIT_API_SECRET') };
  const storage = { account: t('AZURE_STORAGE_ACCOUNT'), key: t('AZURE_STORAGE_KEY'), container: t('AZURE_STORAGE_CONTAINER') };
  const speech = { key: t('AZURE_SPEECH_KEY'), region: t('AZURE_SPEECH_REGION').toLowerCase(), apiVersion: t('AZURE_SPEECH_API_VERSION') || SPEECH_API_VERSION };
  const ai = { endpoint: t('AZURE_OPENAI_ENDPOINT'), key: t('AZURE_OPENAI_API_KEY'), apiVersion: t('AZURE_OPENAI_API_VERSION') || '2024-12-01-preview' };
  const checks = {
    RECORDING_ENABLED: truthy(env.RECORDING_ENABLED),
    LIVEKIT_URL: /^wss?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(livekit.url),
    LIVEKIT_API_KEY: !!livekit.apiKey,
    LIVEKIT_API_SECRET: !!livekit.apiSecret,
    AZURE_STORAGE_ACCOUNT: /^[a-z0-9]{3,24}$/.test(storage.account),
    AZURE_STORAGE_KEY: /^[A-Za-z0-9+/=]{20,200}$/.test(storage.key),
    AZURE_STORAGE_CONTAINER: /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(storage.container),
    AZURE_SPEECH_KEY: !!speech.key,
    AZURE_SPEECH_REGION: /^[a-z0-9]{2,40}$/.test(speech.region),
    CRON_SECRET: t('CRON_SECRET').length >= 16,
    SUPABASE_SERVICE_ROLE_KEY: !!t('SUPABASE_SERVICE_ROLE_KEY'),
  };
  const missing = Object.keys(checks).filter(k => !checks[k]);
  return {
    configured: missing.length === 0, missing, livekit, storage, speech, ai,
    aiConfigured: !!(ai.endpoint && ai.key),
    cronSecret: t('CRON_SECRET'),
    // the Azure OpenAI deployments (same variables as api/generate.js)
    deployment: t('AZURE_OPENAI_DEPLOYMENT') || 'gpt-4o', deploymentMini: t('AZURE_OPENAI_DEPLOYMENT_MINI'),
    // token cap per class (all AI calls of one class: teacher report + every student batch)
    sessionTokenCap: Math.max(20000, parseInt(env.INSIGHTS_SESSION_TOKEN_CAP || '', 10) || 150000),
    // Spanish of the transcription when the class says only "Spanish": es-UY (Uruguay) unless RECORDING_SPANISH_LOCALE=es-ES
    spanishLocale: t('RECORDING_SPANISH_LOCALE') === 'es-ES' ? 'es-ES' : 'es-UY',
  };
}
export const recordingConfigured = (env = process.env) => recordingEnv(env).configured;

// Vercel cron: "Authorization: Bearer <CRON_SECRET>" (constant-time comparison; an empty secret never matches)
export function cronAuthorized(req, secret) {
  const s = String(secret || '');
  if (s.length < 16) return false;
  const got = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const a = createHash('sha256').update(got).digest(); const b = createHash('sha256').update(s).digest();
  return got.length > 0 && timingSafeEqual(a, b);
}

// Transcription locale: the class's own language ("es-UY", "Spanish", "English", "es"…) → en-US | es-UY | es-ES.
// Default en-US (TEC teaches English).
export function speechLocale(hints, env = {}) {
  for (const h of Array.isArray(hints) ? hints : [hints]) {
    const v = String(h || '').trim().toLowerCase();
    if (!v) continue;
    if (v === 'es-uy' || v === 'es-es' || v === 'en-us') return v.slice(0, 3) + v.slice(3).toUpperCase();
    if (/^(es|spa|spanish|español|espanol|castellano)\b/.test(v) || v.startsWith('es-')) return env.spanishLocale || 'es-UY';
    if (/^(en|eng|english|inglés|ingles)\b/.test(v) || v.startsWith('en-')) return 'en-US';
  }
  return 'en-US';
}
