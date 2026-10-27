// Plan & usage (AI tokens) — server side only.
// Uses SUPABASE_SERVICE_ROLE_KEY (Vercel env) to call the security-definer functions that only the
// service role may execute (ai_budget_check, ai_record_usage, billing_service_ping). The key never
// leaves the server and is never included in a response.

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ppvqkjchhejjulrdqkdr.supabase.co';
const TIMEOUT_MS = 10000;

export function serviceKey() {
  const k = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return k || null;
}

// Legacy service_role keys are JWTs (sent as apikey + Bearer). New secret keys (sb_secret_…)
// are not JWTs: they go only in the apikey header.
export function serviceHeaders(key) {
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_secret_')) h.Authorization = `Bearer ${key}`;
  return h;
}

// POST /rest/v1/rpc/<fn> with the service key. Returns the parsed JSON, or null on any failure.
export async function serviceRpc(fn, body, { timeoutMs = TIMEOUT_MS } = {}) {
  const key = serviceKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: serviceHeaders(key), body: JSON.stringify(body || {}), signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) { console.error(`billing: ${fn} failed (HTTP ${r.status})`); return null; }
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  } catch (err) {
    console.error(`billing: ${fn} failed (${err?.name === 'AbortError' ? 'timeout' : 'network'})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let warned = false;
export function warnNotConfigured() {
  if (warned) return;
  warned = true;
  console.warn('billing: SUPABASE_SERVICE_ROLE_KEY is not set — AI token limits are NOT enforced and usage is not recorded.');
}

export async function budgetCheck(userId) {
  const b = await serviceRpc('ai_budget_check', { p_user: userId });
  return b && typeof b.allowed === 'boolean' ? b : null;
}

const KINDS = new Set(['generate', 'continue', 'verify', 'student', 'playbook', 'other']);
export function cleanKind(k) { return KINDS.has(k) ? k : 'generate'; }

export async function recordUsage(userId, usage, kind) {
  const prompt = Math.max(0, Math.round(Number(usage?.prompt_tokens) || 0));
  const completion = Math.max(0, Math.round(Number(usage?.completion_tokens) || 0));
  return serviceRpc('ai_record_usage', { p_user: userId, p_prompt: prompt, p_completion: completion, p_kind: cleanKind(kind) });
}

// What the browser may know after a request (no ids, no other accounts).
export function publicBudget(b) {
  if (!b || typeof b !== 'object') return null;
  return { scope: b.scope, remaining: b.remaining ?? null, warn: !!b.warn, allowance: b.allowance ?? null };
}

export const BUDGET_MESSAGES = {
  personal: 'You have used your free AI allowance for this month. It renews on the 1st of next month.',
  admin_buy: 'Your institution has used all its classes for this month. Add a class pack to keep generating.',
  admin_ask: "Your institution has used all its classes for this month. Ask the main institution's admin to add a class pack.",
  teacher: 'Your institution has used all its classes for this month. Tell your admin so they can add a class pack.',
};

// 402 body when the budget is used up
export function budgetError(b) {
  const scope = b?.scope === 'personal' ? 'personal' : 'institution';
  const isAdmin = !!b?.is_admin, canBuy = !!b?.can_buy;
  const error = scope === 'personal' ? BUDGET_MESSAGES.personal
    : canBuy ? BUDGET_MESSAGES.admin_buy : isAdmin ? BUDGET_MESSAGES.admin_ask : BUDGET_MESSAGES.teacher;
  return { code: 'budget', error, scope, is_admin: isAdmin, can_buy: canBuy, resets_on: b?.resets_on || null };
}
