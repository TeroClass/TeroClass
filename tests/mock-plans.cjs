// Simulated plans / free trial / sales leads / model comparison RPCs for the e2e suites (same rules as 001_base.sql, simplified).
// The free trial is OFF by default in the mock (my_trial_status → {trial:false}) so the other suites never see the pop-ups;
// tests/e2e-plans.cjs turns it on with plans.state.trialOn = true. generate(me, body) simulates what /api/generate +
// consume_ai_quota decide (trial limit, model override only for the super admin, per-kind default model).
const fs = require('fs');
const path = require('path');
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/001_base.sql'), 'utf8').split('$plans$')[1]);
const ACTIVE = ['pilot', 'active', 'founder', 'enterprise'];

module.exports = function ({ db, uid, instById, rootOf, account, bill }) {
  const fresh = () => ({ trialOn: false, plans: JSON.parse(JSON.stringify(SEED)), trial: {}, leads: [], individual: {}, comparisons: [],
    modelDefault: { main: 'default', student: 'default', summary: 'default', verify: 'default', insights: 'default' }, mini: { input: 0.4, output: 1.6 }, gens: [] });
  const state = fresh();
  const reset = () => Object.assign(state, fresh());
  const prof = me => me && db.profiles.find(p => p.id === me.id);
  const isTrial = p => {
    if (!state.trialOn || !p || !['teacher', 'org_admin'].includes(p.role)) return false;
    if (['active', 'pilot'].includes(state.individual[p.id]?.plan_status)) return false;
    if (!p.institution_id) return true;
    return !ACTIVE.includes(account(rootOf(p.institution_id)).plan_status || 'none');
  };
  const tstate = id => state.trial[id] || (state.trial[id] = { used: 0, paywall_shown_at: null, reminder_shown_at: null, limit_shown_at: null, dismissed_at: null, sales_clicked_at: null });
  function status(me) {
    const p = prof(me); if (!isTrial(p)) return { trial: false };
    const t = tstate(p.id); const lim = state.plans.trial.generations_lifetime;
    return { trial: true, used: t.used, limit: lim, remaining: Math.max(lim - t.used, 0), paywall_at: state.plans.trial.paywall_at, reminder_at: state.plans.trial.reminder_at,
      watermark: state.plans.trial.pdf_watermark !== false, in_institution: !!p.institution_id, is_admin: p.role === 'org_admin',
      plan_status: p.institution_id ? (account(rootOf(p.institution_id)).plan_status || 'none') : null, lead_sent: state.leads.some(l => l.user_id === p.id),
      paywall_shown_at: t.paywall_shown_at, reminder_shown_at: t.reminder_shown_at, limit_shown_at: t.limit_shown_at, dismissed_at: t.dismissed_at };
  }
  const now = () => new Date().toISOString();
  const err = m => ({ status: 400, data: { code: 'P0001', message: m } });
  const NOAUTH = err('No autorizado');
  const isSA = me => prof(me)?.role === 'superadmin';

  function getPlans() {
    const p = JSON.parse(JSON.stringify(state.plans));
    p.launch_offers = p.launch_offers.filter(o => o.enabled);
    p.founder_taken = Object.values(bill.accounts).filter(a => a.plan_status === 'founder').length;
    return p;
  }
  function updatePlans(p) {
    const v = state.plans; const num = (x, k) => (x && typeof x[k] === 'number' ? x[k] : undefined);
    if (p.trial) { for (const k of ['generations_lifetime', 'paywall_at', 'reminder_at']) if (num(p.trial, k) !== undefined) v.trial[k] = p.trial[k]; if (typeof p.trial.pdf_watermark === 'boolean') v.trial.pdf_watermark = p.trial.pdf_watermark; }
    const plan = id => v.plans.find(x => x.id === id);
    if (p.docente) { const d = plan('docente'); const x = p.docente;
      if (num(x, 'usd_monthly') !== undefined) d.prices.usd.monthly = x.usd_monthly; if (num(x, 'usd_annual') !== undefined) d.prices.usd.annual = x.usd_annual;
      if (num(x, 'eur_monthly') !== undefined) d.prices.eur.monthly = x.eur_monthly; if (num(x, 'eur_annual') !== undefined) d.prices.eur.annual = x.eur_annual;
      if (num(x, 'generations_per_month') !== undefined) d.limits.generations_per_month = x.generations_per_month; }
    if (p.institucion?.tiers) plan('institucion').tiers.forEach((t, i) => { const x = p.institucion.tiers[i] || {};
      if (num(x, 'usd_annual_per_month') !== undefined) t.usd.annual_per_month = x.usd_annual_per_month; if (num(x, 'usd_monthly') !== undefined) t.usd.monthly = x.usd_monthly; });
    if (p.addons) v.addons.forEach(a => { const x = p.addons[a.id]; if (x) { if (num(x, 'usd') !== undefined) a.usd = x.usd; if (num(x, 'eur') !== undefined) a.eur = x.eur; } });
    if (p.launch_offers) v.launch_offers.forEach(o => { if (typeof p.launch_offers[o.id] === 'boolean') o.enabled = p.launch_offers[o.id]; });
    return v;
  }
  function insertLead(lead, me, source) {
    const p = prof(me);
    const r = { id: uid(), created_at: now(), user_id: p ? p.id : null, anonymous: !p, source: ['popup_gen2', 'popup_gen4', 'paywall', 'plans_page', 'plan_usage'].includes(source) ? source : 'other',
      lang: lead.lang === 'en' ? 'en' : 'es', name: String(lead.name || '').replace(/[<>]/g, ' ').trim(), institution: String(lead.institution || '').trim(), role: lead.role, country: String(lead.country || '').toUpperCase(),
      teachers_count: lead.teachers_count, contact_channel: lead.contact_channel, whatsapp: String(lead.whatsapp || '').replace(/[\s().-]/g, ''), email: String(lead.email || '').toLowerCase(),
      preferred_plan: lead.preferred_plan || 'unsure', message: String(lead.message || ''), status: 'nuevo', notes: '', notified_at: null, updated_at: now() };
    state.leads.push(r); if (p && isTrial(p)) tstate(p.id).sales_clicked_at = tstate(p.id).sales_clicked_at || now();
    return r;
  }
  // POST /api/notify/lead as the server would answer it (signed in only, unless anon=true is passed by the test)
  function submitLead(me, body, { anon = false } = {}) {
    const p = prof(me);
    if (!p && !anon) return { status: 401, body: { code: 'auth', error: 'Please sign in (or create a free account) to contact sales.' } };
    if (p && p.role === 'student') return { status: 403, body: { code: 'forbidden' } };
    const l = body?.lead || {};
    for (const f of ['name', 'institution', 'role', 'country', 'teachers_count', 'email']) if (!String(l[f] || '').trim()) return { status: 400, body: { code: 'invalid', field: f } };
    if (l.consent !== true) return { status: 400, body: { code: 'consent' } };
    const r = insertLead(l, me, body.source); return { status: 200, body: { ok: true, id: r.id, emailed: false } };
  }
  // /api/generate as the server would answer it: trial limit (402), model override (403 unless super admin)
  function generate(me, body, content) {
    const p = prof(me); const kind = body.kind || 'generate';
    if (body.model !== undefined && !['default', 'mini'].includes(body.model)) return { status: 400, body: { code: 'invalid', error: 'Invalid request.' } };
    if (body.model !== undefined && p?.role !== 'superadmin') return { status: 403, body: { code: 'model_forbidden', error: 'Only the platform owner can choose the AI model.' } };
    if (isTrial(p) && kind === 'generate' && tstate(p.id).used >= state.plans.trial.generations_lifetime) {
      return { status: 402, body: { code: 'trial_limit', error: "You've used your free trial classes. Everything you created is still here to view and export. To create new classes, choose a plan.", trial_used: tstate(p.id).used, trial_limit: state.plans.trial.generations_lifetime } };
    }
    const group = kind === 'student' ? 'student' : kind === 'verify' ? 'verify' : kind === 'playbook' ? 'summary' : 'main';
    const model = body.model || state.modelDefault[group] || 'default';
    if (isTrial(p) && kind === 'generate') tstate(p.id).used++;
    state.gens.push({ user: p?.id, kind, model });
    const text = typeof content === 'function' ? content(model, kind, body) : content;
    return { status: 200, body: { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: model === 'mini' ? 1500 : 1800, completion_tokens: model === 'mini' ? 700 : 900 },
      model: { used: model, ...(body.model ? { deployment: model === 'mini' ? 'gpt-4.1-mini' : 'gpt-4o' } : {}) } } };
  }

  function handle(fn, body, me) {
    const p = prof(me);
    switch (fn) {
      case 'get_plans': return { status: 200, data: getPlans() };
      case 'my_trial_status': if (!me) return NOAUTH; return { status: 200, data: status(me) };
      case 'trial_mark': {
        if (!me) return NOAUTH; if (!['paywall', 'reminder', 'limit', 'dismiss', 'sales'].includes(body.p_what)) return err('Aviso inválido');
        if (!isTrial(p)) return { status: 200, data: { trial: false } };
        const t = tstate(p.id); const k = { paywall: 'paywall_shown_at', reminder: 'reminder_shown_at', limit: 'limit_shown_at', sales: 'sales_clicked_at' }[body.p_what];
        if (k) t[k] = t[k] || now(); else t.dismissed_at = now();
        (state.marks = state.marks || []).push(body.p_what);
        return { status: 200, data: status(me) };
      }
      case 'update_plans': if (!isSA(me)) return NOAUTH; return { status: 200, data: updatePlans(body.p || {}) };
      case 'set_institution_plan_status': {
        if (!isSA(me)) return NOAUTH; const a = account(body.p_root); const was = ACTIVE.includes(a.plan_status || 'none');
        Object.assign(a, { plan_status: body.p_status, plan_id: body.p_plan || a.plan_id || null }); if (!was && ACTIVE.includes(body.p_status)) a.plan_activated_at = now();
        return { status: 200, data: { root_id: body.p_root, plan_status: a.plan_status, plan_id: a.plan_id } };
      }
      case 'set_individual_plan': {
        if (!isSA(me)) return NOAUTH; const t = db.profiles.find(x => x.email === String(body.p_email || '').trim().toLowerCase());
        if (!t) return err('No hay ninguna cuenta con ese email');
        if (body.p_status === 'none') delete state.individual[t.id]; else state.individual[t.id] = { plan_status: body.p_status, note: body.p_note || '', activated_at: now(), updated_at: now() };
        return { status: 200, data: { email: t.email, plan_status: body.p_status } };
      }
      case 'list_individual_plans': if (!isSA(me)) return NOAUTH;
        return { status: 200, data: Object.entries(state.individual).map(([id, x]) => { const t = db.profiles.find(q => q.id === id) || {}; return { email: t.email, name: t.name, plan_id: 'docente', ...x }; }) };
      case 'list_sales_leads': if (!isSA(me)) return NOAUTH;
        return { status: 200, data: state.leads.filter(l => !body.p_status || l.status === body.p_status).slice().reverse().map(l => { const u = db.profiles.find(q => q.id === l.user_id);
          return { ...l, user_id: undefined, account_email: u?.email || null, classes_generated: u ? (state.trial[u.id]?.used || 0) : null }; }) };
      case 'update_sales_lead': {
        if (!isSA(me)) return NOAUTH; if (!['nuevo', 'contactado', 'ganado', 'perdido'].includes(body.p_status)) return err('Estado inválido');
        const l = state.leads.find(x => x.id === body.p_id); if (!l) return err('Pedido no encontrado');
        Object.assign(l, { status: body.p_status, notes: body.p_notes ?? l.notes, updated_at: now() }); return { status: 200, data: { id: l.id, status: l.status, notes: l.notes } };
      }
      case 'sales_leads_new_count': if (!isSA(me)) return NOAUTH; return { status: 200, data: state.leads.filter(l => l.status === 'nuevo').length };
      case 'save_model_comparison': {
        if (!isSA(me)) return NOAUTH; const x = body.p || {};
        const winner = x.winner === 'a' ? x.left_model : x.winner === 'b' ? (x.left_model === 'mini' ? 'default' : 'mini') : x.winner === 'tie' ? 'tie' : null;
        if (!winner) return err('Elegí cuál es mejor (A, B o igual)');
        const pr = { default: [bill.settings.ai_price_input, bill.settings.ai_price_output], mini: [state.mini.input, state.mini.output] };
        const results = {}; for (const m of ['default', 'mini']) { const r = x.results?.[m] || {}; results[m] = { ...r, usd: Math.round(((r.prompt_tokens || 0) * pr[m][0] + (r.completion_tokens || 0) * pr[m][1]) / 1e6 * 1e5) / 1e5 }; }
        const row = { id: uid(), created_at: now(), title: x.title, params: x.params, left_model: x.left_model, winner, note: x.note || '', results, texts: x.texts };
        state.comparisons.push(row); return { status: 200, data: { id: row.id, winner, left_model: row.left_model, results } };
      }
      case 'model_comparison_summary': {
        if (!isSA(me)) return NOAUTH; const c = state.comparisons; const n = c.length; const w = k => c.filter(x => x.winner === k).length;
        const avg = (m, k) => (n ? c.reduce((s, x) => s + (x.results[m][k] || 0), 0) / n : null);
        return { status: 200, data: { total: n, wins: { default: w('default'), mini: w('mini'), tie: w('tie') },
          win_rate: n ? { default: Math.round(1000 * w('default') / n) / 10, mini: Math.round(1000 * w('mini') / n) / 10, tie: Math.round(1000 * w('tie') / n) / 10 } : {},
          avg_usd: { default: avg('default', 'usd'), mini: avg('mini', 'usd') }, avg_ms: { default: avg('default', 'ms'), mini: avg('mini', 'ms') },
          recent: c.slice().reverse().map(x => ({ id: x.id, created_at: x.created_at, title: x.title, winner: x.winner, note: x.note, left_model: x.left_model, results: x.results })) } };
      }
      case 'update_ai_model_default': {
        if (!isSA(me)) return NOAUTH; for (const [k, v] of Object.entries(body.p || {})) { if (!['default', 'mini'].includes(v)) return err('Modelo inválido'); if (k in state.modelDefault) state.modelDefault[k] = v; }
        return { status: 200, data: state.modelDefault };
      }
      case 'update_ai_prices_mini': if (!isSA(me)) return NOAUTH; state.mini = { input: body.p_input, output: body.p_output };
        return { status: 200, data: { ai_price_input_mini: body.p_input, ai_price_output_mini: body.p_output } };
      case 'platform_funnel': {
        if (!isSA(me)) return NOAUTH; const staff = db.profiles.filter(x => ['teacher', 'org_admin'].includes(x.role)); const lim = state.plans.trial.generations_lifetime;
        const used = x => state.trial[x.id]?.used || 0;
        return { status: 200, data: { days: body.p_days, limit: lim, signups: staff.length, trial: staff.filter(isTrial).length, first_class: staff.filter(x => used(x) >= 1).length,
          reached_2nd: staff.filter(x => used(x) >= 2).length, saw_paywall: staff.filter(x => state.trial[x.id]?.paywall_shown_at).length, hit_limit: staff.filter(x => used(x) >= lim).length,
          leads: state.leads.length, leads_by_source: {}, converted_institutions: Object.values(bill.accounts).filter(a => a.plan_activated_at && ACTIVE.includes(a.plan_status)).length,
          converted_individuals: Object.values(state.individual).filter(x => ACTIVE.includes(x.plan_status)).length, trial_now: staff.filter(isTrial).length } };
      }
    }
    return null;
  }
  return { state, reset, handle, generate, submitLead, status, SEED };
};
