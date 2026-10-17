// Vercel serverless: genera la planificación con Azure OpenAI.
// La clave de Azure vive SOLO aquí (variables de entorno de Vercel), nunca en el navegador.
// Solo usuarios con sesión iniciada en TeroClass (Supabase) pueden usarla, con un
// límite diario de usos por persona (función consume_ai_quota en Supabase) y, si está la
// clave del servidor (SUPABASE_SERVICE_ROLE_KEY), con el saldo de tokens del plan:
// asignación mensual de la institución (o personal) y después los paquetes comprados.
import { serviceKey, budgetCheck, recordUsage, publicBudget, budgetError, warnNotConfigured } from './_lib/billing.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ppvqkjchhejjulrdqkdr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_D4ZATRSmyiURioJ4PvTb4A_rR_urilK';

const AZURE_TIMEOUT_MS = 55000;     // vercel.json maxDuration = 60s
const SUPABASE_TIMEOUT_MS = 10000;
const MAX_MESSAGES = 20;
const MAX_TOTAL_CHARS = 80000;
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 6000;

class TimeoutError extends Error {}

// fetch + lectura del cuerpo JSON dentro del mismo plazo. Devuelve { ok, status, data }.
async function fetchJson(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, data };
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) throw new TimeoutError('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getUser(token) {
  if (!token) return null;
  const r = await fetchJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  }, SUPABASE_TIMEOUT_MS);
  return r.ok ? r.data : null;
}

// Suma 1 uso del día para este usuario (con SU token: la función decide su límite).
// Devuelve { allowed, used, limit } o null si no se pudo verificar.
async function consumeQuota(token) {
  const r = await fetchJson(`${SUPABASE_URL}/rest/v1/rpc/consume_ai_quota`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  }, SUPABASE_TIMEOUT_MS);
  const q = r.ok ? r.data : null;
  return q && typeof q.allowed === 'boolean' ? q : null;
}

function mapRole(role) {
  return role === 'system' || role === 'assistant' ? role : 'user';
}

function isContentFilterError(data) {
  const e = data?.error || {};
  return e.code === 'content_filter' || e.innererror?.code === 'ResponsibleAIPolicyViolation';
}

const FILTER_ERROR = { error: 'The AI could not write this (content filter). Try rephrasing the topic.', code: 'filter' };
const TIMEOUT_ERROR = { error: 'The AI took too long. Try a shorter class or try again.', code: 'timeout' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
  if (!endpoint || !apiKey) {
    return res.status(500).json({ error: 'AI is not configured on the server yet (missing Azure settings in Vercel).' });
  }

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const user = await getUser(token);
    if (!user?.id) {
      return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
    }

    // Validar antes de gastar cupo
    const { messages, temperature, max_tokens: maxTokensIn, kind } = req.body || {};
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
    }
    const totalChars = messages.reduce((n, m) => n + String(m?.content ?? '').length, 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      return res.status(400).json({ error: 'Request too long.', code: 'too_long' });
    }
    const maxTokens = Number.isFinite(maxTokensIn)
      ? Math.min(Math.max(Math.round(maxTokensIn), MAX_TOKENS_MIN), MAX_TOKENS_MAX)
      : MAX_TOKENS_MAX;

    // Límite diario (falla cerrado: si no se puede verificar, no se llama a Azure)
    const quota = await consumeQuota(token);
    if (!quota) {
      return res.status(503).json({ error: 'Could not check your daily AI limit. Please try again.', code: 'quota_check' });
    }
    if (!quota.allowed) {
      return res.status(429).json({
        error: `Daily AI limit reached (${quota.limit} per day). Try again tomorrow.`,
        code: 'quota', used: quota.used, limit: quota.limit,
      });
    }

    // Saldo de tokens del plan (con la clave del servidor; el usuario no lo puede falsear).
    // Sin la clave: la app sigue funcionando sin límites de tokens (aviso en los logs y en Plataforma).
    const billingOn = !!serviceKey();
    if (billingOn) {
      const budget = await budgetCheck(user.id);
      if (!budget) {
        return res.status(503).json({ error: 'Could not check your AI token balance. Please try again.', code: 'budget_check' });
      }
      if (!budget.allowed) return res.status(402).json(budgetError(budget));
    } else {
      warnNotConfigured();
    }

    const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    let response;
    try {
      response = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          messages: messages.map(m => ({ role: mapRole(m?.role), content: String(m?.content ?? '') })),
          max_tokens: maxTokens,
          temperature: typeof temperature === 'number' ? Math.min(Math.max(temperature, 0), 1.2) : 0.7,
          user: user.id,
        }),
      }, AZURE_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimeoutError) return res.status(504).json(TIMEOUT_ERROR);
      return res.status(502).json({ error: 'Could not reach the AI service. Please try again.', code: 'upstream' });
    }

    const data = response.data;
    // Anotar el consumo real que informa Azure (si la anotación falla, la respuesta igual llega)
    let after = null;
    if (billingOn && response.ok && data?.usage) {
      after = await recordUsage(user.id, data.usage, kind);
    }
    if (!response.ok) {
      if (isContentFilterError(data)) return res.status(422).json(FILTER_ERROR);
      const status = response.status === 429 ? 429 : (response.status >= 500 ? 502 : response.status);
      return res.status(status).json({
        error: data?.error?.message || `AI service error (${response.status}).`,
        code: response.status === 429 ? 'rate_limit' : 'upstream',
      });
    }
    if (!data || !Array.isArray(data.choices) || !data.choices.length) {
      return res.status(502).json({ error: 'The AI returned an empty answer. Please try again.', code: 'upstream' });
    }
    const choice = data.choices[0];
    if (choice?.message?.content == null) {
      return res.status(422).json(FILTER_ERROR);
    }
    // Respuesta completa de Azure (incluye choices[0].finish_reason, p. ej. 'length')
    return res.status(200).json({ ...data, quota: { used: quota.used, limit: quota.limit }, budget: publicBudget(after) });
  } catch (err) {
    if (err instanceof TimeoutError) return res.status(504).json(TIMEOUT_ERROR);
    return res.status(500).json({ error: err?.message || 'Server error', code: 'server' });
  }
}
