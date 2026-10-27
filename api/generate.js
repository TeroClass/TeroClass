// Vercel serverless: genera la planificación con Azure OpenAI.
// La clave de Azure vive SOLO aquí (variables de entorno de Vercel), nunca en el navegador.
// Solo usuarios con sesión iniciada en TeroClass (Supabase) pueden usarla, con un
// límite diario de usos por persona (función consume_ai_quota en Supabase) y, si está la
// clave del servidor (SUPABASE_SERVICE_ROLE_KEY), con el saldo de tokens del plan:
// asignación mensual de la institución (o personal) y después los paquetes comprados.
// Cada pedido queda anotado con sus metadatos (tipo, materias, idioma, edad, nivel, barras) en ai_events
// vía consume_ai_quota, con el token del usuario: funciona aun sin la clave del servidor (Insights).
//
// Auditoría 2026-10:
//  · TC-01: solo acepta los pedidos que arma la app (api/_lib/guard.js: tipo, 2 mensajes, prompt de sistema propio,
//    tamaños) y aplica un límite por IP (base de datos: ip_rate_hit con una clave HMAC de la IP; además uno en memoria).
//    Estas protecciones funcionan aunque falte SUPABASE_SERVICE_ROLE_KEY.
//  · TC-09: plazo total de 55 s desde que entra el pedido (Vercel corta a los 60 s). A Azure se le pide en streaming y,
//    si el tiempo se acaba, se devuelve lo escrito hasta ahí con finish_reason "length": la app pide la continuación.
//    max_tokens por tipo de pedido (guard.js).
//  · TC-20: al navegador solo le llegan mensajes genéricos; el detalle queda en los logs.
//  · TC-01: además de los pedidos por día, cada pedido descuenta sus tokens ESTIMADOS (entrada / 4 + max_tokens) del tope
//    diario de la persona y del de su institución (platform_settings; consume_ai_quota). Cuentas sin institución o con
//    el email sin confirmar: muy poco. Todo con el token del usuario (sin la clave del servidor).
//
// Planes y prueba gratis (2026-10-21):
//  · PRUEBA GRATIS: consume_ai_quota (token del usuario, sin la clave del servidor) cuenta las clases completas de quien
//    está en prueba; al intentar la 6ª responde reason 'trial_limit' → 402 {code:'trial_limit'} y la app abre los planes.
//    El pedido se marca como fallido solo con su finish_key (la persona no la ve: nadie se "devuelve" una clase).
//  · MODELO: body.model ('default' | 'mini') solo lo acepta el súper admin (comparar modelos; la base lo decide:
//    reason 'model' → 403). Sin body.model vale el ajuste de la plataforma por tipo de pedido (ai_model_default).
//    'mini' usa AZURE_OPENAI_DEPLOYMENT_MINI; si no existe, el despliegue de siempre (model.fallback = true).
import { serviceKey, budgetCheck, recordUsage, publicBudget, budgetError, warnNotConfigured } from './_lib/billing.js';
import { sanitizeMeta } from './_lib/meta.js';
import { validateGenerateBody, clientIp, ipKey, memRateHit } from './_lib/guard.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ppvqkjchhejjulrdqkdr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_D4ZATRSmyiURioJ4PvTb4A_rR_urilK';

// vercel.json maxDuration = 60 s: 5 s de margen para anotar el uso y responder (GENERATE_DEADLINE_MS solo para pruebas)
export const deadlineMs = () => Math.min(Math.max(parseInt(process.env.GENERATE_DEADLINE_MS || '', 10) || 55000, 6000), 55000);
const FINISH_MARGIN_MS = 2500;      // lo que se reserva al final para recordUsage / finish_ai_event
const SUPABASE_TIMEOUT_MS = 10000;
// Pedidos por hora y por IP (todas las cuentas detrás de esa IP: un colegio entero comparte una IP)
const IP_HOURLY = () => Math.max(10, parseInt(process.env.AI_IP_HOURLY_LIMIT || '', 10) || 300);

class TimeoutError extends Error {}

// fetch + lectura del cuerpo JSON dentro del mismo plazo. Devuelve { ok, status, data }.
async function fetchJson(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ms));
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

async function getUser(token, ms) {
  if (!token) return null;
  const r = await fetchJson(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  }, ms);
  return r.ok ? r.data : null;
}

function userRpc(fn, token, body, ms = SUPABASE_TIMEOUT_MS) {
  return fetchJson(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  }, ms);
}

// Tokens ESTIMADOS de un pedido (TC-01): ~4 caracteres por token de entrada + el máximo de salida permitido.
export const estimateTokens = (messages, maxTokens) =>
  Math.ceil((messages || []).reduce((n, m) => n + String(m?.content || '').length, 0) / 4) + (Number(maxTokens) || 0);

// Suma 1 uso del día para este usuario (con SU token: la función decide sus límites: pedidos por día y tokens estimados
// por día de la persona y de su institución, TC-01) y anota el pedido con sus metadatos ya limpios.
// Devuelve { allowed, used, limit, reason?, event? } o null si no se pudo verificar.
// Si la base todavía no tiene la versión nueva (script sin volver a correr), reintenta con la firma anterior.
async function consumeQuota(token, meta, est, ms, model) {
  const missing = x => !x.ok && (x.status === 404 || x.data?.code === 'PGRST202');
  let r;
  if (model) { // base sin la versión con p_model (script sin volver a correr): sin poder verificar al súper admin, se ignora
    r = await userRpc('consume_ai_quota', token, { ...(meta ? { p_meta: meta } : {}), p_est_tokens: est, p_model: model }, ms);
    if (missing(r)) r = null;
  }
  if (!r) r = await userRpc('consume_ai_quota', token, { ...(meta ? { p_meta: meta } : {}), p_est_tokens: est }, ms);
  if (missing(r)) r = await userRpc('consume_ai_quota', token, meta ? { p_meta: meta } : {}, ms);
  if (missing(r) && meta) r = await userRpc('consume_ai_quota', token, {}, ms);
  const q = r.ok ? r.data : null;
  return q && typeof q.allowed === 'boolean' ? q : null;
}

// Límite global por IP en la base (clave HMAC de la IP). true = permitido. Si la base todavía no tiene la función
// (script sin volver a correr) o no responde, no bloquea: queda el límite en memoria y la cuota diaria.
async function ipAllowed(token, req, ms) {
  const secret = process.env.RATE_LIMIT_SECRET || process.env.AZURE_OPENAI_API_KEY || '';
  const key = ipKey('ai', clientIp(req), secret);
  if (!memRateHit(key, IP_HOURLY(), 3600000)) return false;
  try {
    const r = await userRpc('ip_rate_hit', token, { p_key: key, p_limit: IP_HOURLY(), p_window_s: 3600 }, Math.min(ms, 5000));
    if (r.ok) return r.data !== false;
    console.warn(`generate: ip_rate_hit unavailable (HTTP ${r.status}) — run the new 001_base.sql`);
  } catch { console.warn('generate: ip_rate_hit failed (timeout/network)'); }
  return true;
}

// Marca cómo terminó el pedido (para no contar como "clase generada" un error). Nunca hace fallar la respuesta.
async function finishEvent(token, event, ok, key) {
  if (!Number.isSafeInteger(event) || event <= 0) return;
  const body = { p_event: event, p_ok: !!ok, ...(typeof key === 'string' && /^[0-9a-f]{16,64}$/.test(key) ? { p_key: key } : {}) };
  try { await userRpc('finish_ai_event', token, body, 3000); } catch { /* best effort */ }
}

// Qué despliegue de Azure usar: 'mini' solo si existe AZURE_OPENAI_DEPLOYMENT_MINI (si no, el de siempre).
export function pickDeployment(choice, env = process.env) {
  const def = env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const mini = String(env.AZURE_OPENAI_DEPLOYMENT_MINI || '').trim();
  if (choice === 'mini' && /^[A-Za-z0-9._-]{1,64}$/.test(mini)) return { used: 'mini', deployment: mini, fallback: false };
  return { used: 'default', deployment: def, fallback: choice === 'mini' };
}
export const TRIAL_ERROR = "You've used your free trial classes. Everything you created is still here to view and export. To create new classes, choose a plan.";

function isContentFilterError(data) {
  const e = data?.error || {};
  return e.code === 'content_filter' || e.innererror?.code === 'ResponsibleAIPolicyViolation';
}

const FILTER_ERROR = { error: 'The AI could not write this (content filter). Try rephrasing the topic.', code: 'filter' };
const TIMEOUT_ERROR = { error: 'The AI took too long. Try a shorter class or try again.', code: 'timeout' };
const UPSTREAM_ERROR = { error: 'The AI did not answer. Try again in a moment.', code: 'upstream' };

// Azure en streaming (SSE). Lee hasta que termina o hasta `ms`; si el plazo se acaba devuelve lo que ya llegó con
// finish_reason "length" (partial = true). Si Azure contesta JSON (error, o un servidor sin streaming), lo devuelve igual.
export async function azureStream(url, apiKey, payload, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ms));
  let content = ''; let finish = null; let usage = null; let filtered = false;
  try {
    const r = await fetch(url, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }) });
    const ctype = r.headers?.get?.('content-type') || '';
    if (!r.ok || !/text\/event-stream/i.test(ctype) || !r.body) {
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { ok: r.ok, status: r.status, data };
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') continue;
          let j; try { j = JSON.parse(d); } catch { continue; }
          if (j.usage) usage = j.usage;
          const c = Array.isArray(j.choices) ? j.choices[0] : null;
          if (c?.delta?.content) content += c.delta.content;
          if (c?.finish_reason) { finish = c.finish_reason; if (finish === 'content_filter') filtered = true; }
        }
      }
    } catch (err) {
      if (!(err?.name === 'AbortError' || controller.signal.aborted)) throw err;
      // plazo vencido en medio de la respuesta: devolver lo que llegó
      return { ok: true, status: 200, partial: true, data: { choices: [{ message: { role: 'assistant', content }, finish_reason: 'length' }],
        usage: usage || estimateUsage(payload, content) } };
    }
    if (filtered && !content.trim()) return { ok: false, status: 400, data: { error: { code: 'content_filter' } } };
    return { ok: true, status: 200, data: { choices: [{ message: { role: 'assistant', content }, finish_reason: finish || 'stop' }],
      usage: usage || estimateUsage(payload, content) } };
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      if (content) return { ok: true, status: 200, partial: true, data: { choices: [{ message: { role: 'assistant', content }, finish_reason: 'length' }], usage: usage || estimateUsage(payload, content) } };
      throw new TimeoutError('timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
// Sin el bloque de uso (corte por plazo): estimación ~4 caracteres por token, para que el consumo igual se anote
function estimateUsage(payload, content) {
  const inChars = (payload.messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
  const p = Math.ceil(inChars / 4); const c = Math.ceil(String(content || '').length / 4);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, estimated: true };
}

export default async function handler(req, res) {
  const start = Date.now(); const DEADLINE = deadlineMs();
  const left = () => DEADLINE - (Date.now() - start);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
  if (!endpoint || !apiKey) {
    return res.status(500).json({ error: 'AI is not configured on the server yet (missing Azure settings in Vercel).' });
  }

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const user = await getUser(token, Math.min(SUPABASE_TIMEOUT_MS, left()));
    if (!user?.id) {
      return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
    }

    // Validar antes de gastar cupo: solo los pedidos que arma la app (TC-01)
    const v = validateGenerateBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code });
    const { kind, messages, maxTokens, temperature } = v;
    // Modelo elegido a mano (solo el súper admin: lo decide la base en consume_ai_quota)
    const wantModel = req.body?.model;
    if (wantModel !== undefined && wantModel !== null && wantModel !== 'default' && wantModel !== 'mini') {
      return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
    }

    if (!(await ipAllowed(token, req, Math.min(SUPABASE_TIMEOUT_MS, left())))) {
      return res.status(429).json({ error: 'Too many requests right now. Wait a moment and try again.', code: 'ip_rate' });
    }

    // Límite diario (falla cerrado: si no se puede verificar, no se llama a Azure)
    const quota = await consumeQuota(token, sanitizeMeta(req.body?.meta, kind), estimateTokens(messages, maxTokens), Math.min(SUPABASE_TIMEOUT_MS, left()), wantModel || null);
    if (!quota) {
      return res.status(503).json({ error: 'Could not check your daily AI limit. Please try again.', code: 'quota_check' });
    }
    if (!quota.allowed) {
      if (quota.reason === 'trial_limit') {
        return res.status(402).json({ error: TRIAL_ERROR, code: 'trial_limit', trial_used: quota.trial_used ?? null, trial_limit: quota.trial_limit ?? null });
      }
      if (quota.reason === 'model') {
        return res.status(403).json({ error: 'Only the platform owner can choose the AI model.', code: 'model_forbidden' });
      }
      if (quota.reason === 'institution') {
        return res.status(429).json({ error: "Your institution reached today's AI limit. Try again tomorrow or ask your admin.", code: 'quota_institution' });
      }
      if (quota.reason === 'tokens') {
        return res.status(429).json({ error: "You reached today's AI limit for your account. Try again tomorrow.", code: 'quota_tokens' });
      }
      return res.status(429).json({
        error: `Daily AI limit reached (${quota.limit} per day). Try again tomorrow.`,
        code: 'quota', used: quota.used, limit: quota.limit,
      });
    }

    // El pedido ya quedó anotado (quota.event): al final se marca si terminó bien. La respuesta ya salió
    // cuando corre el finally, así que no le suma demora al usuario.
    let ok = false;
    try {
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

      const azureMs = left() - FINISH_MARGIN_MS;
      if (azureMs < 5000) return res.status(504).json(TIMEOUT_ERROR);
      const pick = pickDeployment(quota.model === 'mini' ? 'mini' : 'default');
      const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(pick.deployment)}/chat/completions?api-version=${apiVersion}`;
      let response;
      try {
        response = await azureStream(url, apiKey, { messages, max_tokens: maxTokens, temperature, user: user.id }, azureMs);
      } catch (err) {
        if (err instanceof TimeoutError) return res.status(504).json(TIMEOUT_ERROR);
        console.error('generate: Azure request failed', err?.message || err);
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
        console.error(`generate: Azure error HTTP ${response.status}`, data?.error?.code || '', data?.error?.message || '');
        if (response.status === 429) return res.status(429).json({ error: 'Too many requests right now. Wait a moment and try again.', code: 'rate_limit' });
        return res.status(502).json(UPSTREAM_ERROR);
      }
      if (!data || !Array.isArray(data.choices) || !data.choices.length) {
        return res.status(502).json({ error: 'The AI returned an empty answer. Please try again.', code: 'upstream' });
      }
      const choice = data.choices[0];
      if (choice?.message?.content == null) {
        return res.status(422).json(FILTER_ERROR);
      }
      // choices[0].finish_reason = 'length' cuando se cortó (por tokens o por plazo): la app pide la continuación
      ok = true;
      // el nombre del despliegue solo vuelve cuando el súper admin eligió el modelo (comparar modelos)
      const model = { used: pick.used, ...(pick.fallback ? { fallback: true } : {}), ...(wantModel ? { deployment: pick.deployment } : {}) };
      return res.status(200).json({ ...data, partial: !!response.partial || undefined, quota: { used: quota.used, limit: quota.limit }, budget: publicBudget(after), model });
    } finally {
      await finishEvent(token, quota.event, ok, quota.finish_key);
    }
  } catch (err) {
    if (err instanceof TimeoutError) return res.status(504).json(TIMEOUT_ERROR);
    console.error('generate: server error', err?.message || err);
    return res.status(500).json({ error: 'Server error', code: 'server' });
  }
}
