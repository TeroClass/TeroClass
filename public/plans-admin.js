// TeroClass — super admin tools for plans and sales (2026-10-21), in Platform. Vanilla JS, no build step.
//   · Sales requests ("Pedidos de ventas"): list, status (nuevo / contactado / ganado / perdido), notes, CSV export, badge on
//     the Platform icon (new requests). Data: list_sales_leads / update_sales_lead / sales_leads_new_count (super admin only).
//   · Plans & pricing: prices and limits of the plans, class packs and the launch-offer switches (update_plans).
//   · Teacher plans for accounts without an institution (set_individual_plan / list_individual_plans).
//   · AI model per kind of request ('default' | 'mini') + the mini model prices (update_ai_model_default / update_ai_prices_mini).
//   · Compare models: a blind A/B of the SAME full generation pipeline with both deployments (window.TCGenerateFull in
//     index.html → /api/generate with model, accepted only from the super admin), rated and stored (save_model_comparison).
// Texts are English source strings translated by the app's i18n layer (I18N_ES below).
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const J = d => { if (typeof d === 'string') { try { return JSON.parse(d); } catch (e) { return null; } } return d; };
  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const lang = () => (typeof uiLang === 'string' ? uiLang : 'en');
  const fmtD = (d, o) => (typeof fmtDate === 'function' ? fmtDate(d, o) : String(d || ''));
  const n2 = v => (Number(v) || 0).toLocaleString(lang() === 'es' ? 'es-UY' : 'en-US', { maximumFractionDigits: 2 });
  const usd = (v, dec = 4) => 'USD ' + (Number(v) || 0).toLocaleString(lang() === 'es' ? 'es-UY' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: dec });
  const blocked = () => (typeof vaBlocked === 'function' ? vaBlocked() : false);

  const A = { overview: null, status: null, leads: [], filter: 'all', plans: null, individual: [], summary: null, saving: {} };
  const CMP = { queue: [], idx: 0, running: false, pair: null, pick: null, saved: false, error: '' };

  const STATUS = ['nuevo', 'contactado', 'ganado', 'perdido'];
  const STATUS_L = { nuevo: 'New', contactado: 'Contacted', ganado: 'Won', perdido: 'Lost' };
  const ROLE_L = { direccion: 'Leadership', coordinacion: 'Academic coordination', docente: 'Teacher', administracion: 'Administration', otro: 'Other' };
  const PLAN_L = { docente: 'Teacher', institucion: 'Institution', institucion_plus: 'Institution+', unsure: 'Not sure yet' };
  const SRC_L = { popup_gen2: 'Pop-up (2nd class)', popup_gen4: 'Reminder (4th class)', paywall: 'Trial limit', plans_page: 'Plans page', plan_usage: 'Plan & usage', other: 'Other' };
  const KIND_L = { main: 'Class (guide + continuation)', student: 'Student handout', summary: 'Playbook summary', verify: 'Calculation check' };
  const OFFER_L = { founder: 'Founding Institutions (30% off year 1, first 10)', pilot_60d: '60-day pilot (USD 150, up to 10 teachers)', pilot_anii: '6-month ANII pilot', trial_email_coupon: 'TERO20 coupon (20% off yearly Teacher)' };

  // ── badge on the Platform icon ──
  async function refreshBadge() {
    if (!window.currentUser?.isSuperAdmin && !(typeof currentUser !== 'undefined' && currentUser?.isSuperAdmin)) return;
    let n = 0;
    try { const { data, error } = await sb.rpc('sales_leads_new_count'); if (!error) n = Number(J(data)) || 0; } catch (e) { n = 0; }
    const nav = $('nav-platform'); if (!nav) return;
    let b = nav.querySelector('.sib-badge');
    if (n > 0) {
      if (!b) { b = document.createElement('span'); b.className = 'sib-badge'; b.setAttribute('data-no-i18n', ''); nav.appendChild(b); }
      b.textContent = n > 99 ? '99+' : String(n); b.title = `${n} ${tr(n === 1 ? 'new sales request' : 'new sales requests')}`;
    } else if (b) b.remove();
  }

  // ── render all cards ──
  async function render({ overview, status } = {}) {
    const box = $('pf-plans-admin'); if (!box || !currentUser?.isSuperAdmin) return;
    A.overview = overview || A.overview; A.status = status ?? A.status;
    A.plans = J(A.overview?.settings?.plans) || A.plans;
    if (!box.dataset.ready) {
      box.innerHTML = `<div class="admin-card bl-pf-card" id="pf-leads-card"></div><div class="admin-card bl-pf-card" id="pf-pricing-card"></div>
        <div class="admin-card bl-pf-card" id="pf-individual-card"></div><div class="admin-card bl-pf-card" id="pf-models-card"></div>
        <div class="admin-card bl-pf-card" id="pf-compare-card"></div>`;
      box.dataset.ready = '1';
    }
    // the editors are built once (a later re-render of Platform must not wipe what is being typed); they redraw after their own save
    if (!$('pp-trial-n')) renderPlansCard();
    if (!document.querySelector('[data-model-kind]')) renderModelsCard();
    renderCompare();
    await Promise.all([loadLeads(), loadIndividual(), loadSummary()]);
    refreshBadge();
  }

  // ── sales requests ──
  async function loadLeads() {
    const { data, error } = await sb.rpc('list_sales_leads', { p_status: null });
    if (error) { $('pf-leads-card').innerHTML = `<div class="bl-empty">${esc(dbErr(error.message))}</div>`; return; }
    A.leads = J(data) || []; renderLeads();
  }
  function renderLeads() {
    const box = $('pf-leads-card'); if (!box) return;
    const rows = A.leads.filter(l => A.filter === 'all' || l.status === A.filter);
    const count = s => A.leads.filter(l => l.status === s).length;
    const mailHint = A.status && A.status.sales_email === false
      ? `<div class="bl-hint" id="pf-leads-mail">E-mail notifications are off: add RESEND_API_KEY and SALES_NOTIFY_EMAIL in Vercel to get an e-mail for each request. Until then they only show here (with a badge on Platform).</div>` : '';
    const wa = n => n ? `<a href="https://wa.me/${esc(String(n).replace(/[^0-9]/g, ''))}" target="_blank" rel="noopener">${esc(n)}</a>` : '';
    const opt = (v, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(tr(STATUS_L[v]))}</option>`;
    box.innerHTML = `<div class="admin-card-title">Sales requests <span>"Talk to sales" from the app and the plans page</span></div>${mailHint}
      <div class="pf-leads-tools"><div class="in-seg" role="group" aria-label="${esc(tr('Status'))}">${['all', ...STATUS].map(s => `<button type="button" data-pa="lead-filter" data-v="${s}" class="${A.filter === s ? 'active' : ''}" aria-pressed="${A.filter === s}"><span>${esc(tr(s === 'all' ? 'All' : STATUS_L[s]))}</span> <span data-no-i18n>(${s === 'all' ? A.leads.length : count(s)})</span></button>`).join('')}</div>
      <button type="button" class="tree-btn" data-pa="lead-csv"${A.leads.length ? '' : ' disabled'}><span data-no-i18n>⬇ CSV</span></button></div>
      <div class="pf-table-scroll"><table class="teachers-table pf-leads"><thead><tr><th>Date</th><th>Person</th><th>Contact</th><th>Request</th><th>Message</th><th>Status &amp; notes</th></tr></thead>
      <tbody id="pf-leads">${rows.length ? rows.map(l => `<tr data-lead="${esc(l.id)}" class="${l.status === 'nuevo' ? 'pf-new' : ''}">
        <td data-no-i18n>${esc(fmtD(l.created_at, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
        <td><b data-no-i18n>${esc(l.name)}</b><div class="bl-sub" data-no-i18n>${esc(l.institution)}</div><div class="bl-sub">${esc(tr(ROLE_L[l.role] || l.role))} · <span data-no-i18n>${esc(l.country)}</span></div>
          ${l.account_email ? `<div class="bl-sub"><span>Account:</span> <span data-no-i18n>${esc(l.account_email)}${l.classes_generated != null ? ` · ${esc(l.classes_generated)} ${esc(tr('classes'))}` : ''}</span></div>` : `<div class="bl-sub">Without an account (verified with Turnstile)</div>`}</td>
        <td data-no-i18n><a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.whatsapp ? `<div>${wa(l.whatsapp)}</div>` : ''}<div class="bl-sub">${esc(tr(l.contact_channel === 'whatsapp' ? 'Prefers WhatsApp' : 'Prefers e-mail'))}${l.notified_at ? ' · ✉' : ''}</div></td>
        <td><span>${esc(tr(PLAN_L[l.preferred_plan] || l.preferred_plan))}</span><div class="bl-sub"><span data-no-i18n>${esc(String(l.teachers_count).replace('-', '–'))}</span> <span>teachers</span></div><div class="bl-sub">${esc(tr(SRC_L[l.source] || l.source))}</div></td>
        <td class="pf-msg" data-no-i18n>${esc(l.message || '')}</td>
        <td class="pf-lead-edit"><select class="settings-input bl-sel" data-f="status" aria-label="${esc(tr('Status'))}">${STATUS.map(s => opt(s, l.status)).join('')}</select>
          <textarea class="settings-input pf-notes" data-f="notes" rows="2" maxlength="2000" aria-label="${esc(tr('Notes'))}" placeholder="${esc(tr('Notes'))}">${esc(l.notes || '')}</textarea>
          <button type="button" class="tree-btn primary" data-pa="lead-save" data-id="${esc(l.id)}">Save</button></td></tr>`).join('')
        : `<tr><td colspan="6" class="muted-cell">${esc(tr(A.leads.length ? 'No requests with this status.' : 'No sales requests yet.'))}</td></tr>`}</tbody></table></div>`;
  }
  async function saveLead(id, btn) {
    if (blocked()) return;
    const tr_ = btn.closest('tr'); const st = tr_.querySelector('[data-f="status"]').value; const notes = tr_.querySelector('[data-f="notes"]').value;
    btn.disabled = true;
    const { error } = await sb.rpc('update_sales_lead', { p_id: id, p_status: st, p_notes: notes });
    btn.disabled = false;
    if (error) { showToast('Error: ' + dbErr(error.message), 'err'); return; }
    const l = A.leads.find(x => x.id === id); if (l) Object.assign(l, { status: st, notes });
    showToast('Request updated ✓', 'ok'); renderLeads(); refreshBadge();
  }
  function leadsCsv() {
    const sep = lang() === 'es' ? ';' : ',';
    const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /["\n\r;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['created_at', 'status', 'name', 'institution', 'role', 'country', 'teachers_count', 'preferred_plan', 'contact_channel', 'email', 'whatsapp', 'source', 'message', 'notes', 'account_email', 'classes_generated'];
    const rows = A.leads.filter(l => A.filter === 'all' || l.status === A.filter);
    const csv = '﻿' + [cols.join(sep), ...rows.map(l => cols.map(c => cell(l[c])).join(sep))].join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `teroclass-pedidos-ventas-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── plans & pricing ──
  function plan(id) { return (A.plans?.plans || []).find(p => p.id === id) || {}; }
  function renderPlansCard() {
    const box = $('pf-pricing-card'); if (!box) return;
    const P = A.plans; if (!P) { box.innerHTML = '<div class="admin-card-title">Plans &amp; pricing</div><div class="bl-empty">Run the new supabase/migrations/001_base.sql to edit the plans.</div>'; return; }
    const num = (id, v, label, step = '0.01') => `<label class="bl-field"><span class="modal-label">${label}</span><input type="number" min="0" step="${step}" id="${id}" class="settings-input" value="${esc(v ?? '')}"></label>`;
    const tr_ = P.trial || {}; const d = plan('docente'); const ins = plan('institucion'); const plus = plan('institucion_plus');
    const tiers = (ins.tiers || []).map((t, i) => `<tr><th scope="row" data-no-i18n>${esc(t.seats_from)}–${esc(t.seats_to)}</th>
      <td><input type="number" min="0" step="0.01" class="settings-input bl-num" id="pp-t${i}-ua" value="${esc(t.usd?.annual_per_month)}" aria-label="USD yearly"></td>
      <td><input type="number" min="0" step="0.01" class="settings-input bl-num" id="pp-t${i}-um" value="${esc(t.usd?.monthly)}" aria-label="USD monthly"></td>
      <td><input type="number" min="0" step="0.01" class="settings-input bl-num" id="pp-t${i}-ea" value="${esc(t.eur?.annual_per_month)}" aria-label="EUR yearly"></td>
      <td><input type="number" min="0" step="0.01" class="settings-input bl-num" id="pp-t${i}-em" value="${esc(t.eur?.monthly)}" aria-label="EUR monthly"></td></tr>`).join('');
    const addons = (P.addons || []).map(a => `<tr><td data-no-i18n>${esc(lang() === 'es' ? a.name_es : a.name_en)}</td>
      <td><input type="number" min="0" step="0.01" class="settings-input bl-num" data-addon="${esc(a.id)}" data-cur="usd" value="${esc(a.usd)}" aria-label="USD"></td>
      <td><input type="number" min="0" step="0.01" class="settings-input bl-num" data-addon="${esc(a.id)}" data-cur="eur" value="${esc(a.eur)}" aria-label="EUR"></td></tr>`).join('');
    const offers = (P.launch_offers || []).map(o => `<label class="switch-row pf-offer"><input type="checkbox" data-offer="${esc(o.id)}"${o.enabled ? ' checked' : ''}> <span>${esc(tr(OFFER_L[o.id] || o.id))}</span></label>`).join('');
    box.innerHTML = `<div class="admin-card-title">Plans &amp; pricing <span>What the plans page and the pop-ups show · <a href="/planes" target="_blank" rel="noopener" data-no-i18n>/planes ↗</a></span></div>
      <div class="bl-subtitle">Free trial</div>
      <div class="bl-settings">${num('pp-trial-n', tr_.generations_lifetime, 'Classes in the trial (total)', '1')}${num('pp-trial-p', tr_.paywall_at, 'Pop-up after class', '1')}${num('pp-trial-r', tr_.reminder_at, 'Reminder after class', '1')}
        <label class="switch-row"><input type="checkbox" id="pp-trial-wm"${tr_.pdf_watermark !== false ? ' checked' : ''}> <span>Watermark on trial PDFs</span></label></div>
      <div class="bl-subtitle">Teacher (individual)</div>
      <div class="bl-settings">${num('pp-d-um', d.prices?.usd?.monthly, 'USD per month')}${num('pp-d-ua', d.prices?.usd?.annual, 'USD per year')}${num('pp-d-em', d.prices?.eur?.monthly, 'EUR per month (VAT incl.)')}${num('pp-d-ea', d.prices?.eur?.annual, 'EUR per year (VAT incl.)')}
        ${num('pp-d-gen', d.limits?.generations_per_month, 'Classes per month', '1')}${num('pp-d-vh', d.limits?.video_hours_per_month, 'Classroom hours per month', '0.5')}</div>
      <div class="bl-subtitle">Institution (per teacher per month)</div>
      <div class="pf-table-scroll"><table class="teachers-table pf-tiers"><thead><tr><th>Teachers</th><th>USD yearly</th><th>USD monthly</th><th>EUR yearly</th><th>EUR monthly</th></tr></thead><tbody>${tiers}</tbody></table></div>
      <div class="bl-settings">${num('pp-i-gen', ins.limits?.generations_per_seat_month, 'Classes per teacher per month', '1')}${num('pp-i-vh', ins.limits?.video_hours_per_seat_month, 'Classroom hours per teacher', '0.5')}${num('pp-i-an', ins.limits?.insights_classes_per_seat_month, 'Analyzed classes per teacher', '1')}
        ${num('pp-p-u', plus.prices?.usd?.reference_per_seat_month_annual, 'Institution+: reference USD')}${num('pp-p-e', plus.prices?.eur?.reference_per_seat_month_annual, 'Institution+: reference EUR')}</div>
      <div class="bl-subtitle">Packs and add-ons</div>
      <div class="pf-table-scroll"><table class="teachers-table pf-addons"><thead><tr><th>Add-on</th><th data-no-i18n>USD</th><th data-no-i18n>EUR</th></tr></thead><tbody>${addons}</tbody></table></div>
      <div class="bl-subtitle">Launch offers</div><div class="bl-hint">They show on the plans page only when switched on. No countdowns or invented scarcity: "places left" only appears when real accounts already have the Founding plan.</div>
      <div class="pf-offers">${offers}</div>
      <div class="bl-row"><button class="btn-modal-save" data-pa="plans-save">Save plans</button> <span class="bl-hint">Changes apply at once (plans page, pop-ups, trial limit).</span></div>`;
  }
  async function savePlans(btn) {
    if (blocked()) return;
    const v = id => { const el = $(id); if (!el || el.value.trim() === '') return undefined; const x = Number(el.value); return Number.isFinite(x) ? x : NaN; };
    const clean = o => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
    const p = {
      trial: clean({ generations_lifetime: v('pp-trial-n'), paywall_at: v('pp-trial-p'), reminder_at: v('pp-trial-r'), pdf_watermark: !!$('pp-trial-wm')?.checked }),
      docente: clean({ usd_monthly: v('pp-d-um'), usd_annual: v('pp-d-ua'), eur_monthly: v('pp-d-em'), eur_annual: v('pp-d-ea'), generations_per_month: v('pp-d-gen'), video_hours_per_month: v('pp-d-vh') }),
      institucion: clean({ generations_per_seat_month: v('pp-i-gen'), video_hours_per_seat_month: v('pp-i-vh'), insights_classes_per_seat_month: v('pp-i-an'),
        tiers: (plan('institucion').tiers || []).map((t, i) => clean({ usd_annual_per_month: v(`pp-t${i}-ua`), usd_monthly: v(`pp-t${i}-um`), eur_annual_per_month: v(`pp-t${i}-ea`), eur_monthly: v(`pp-t${i}-em`) })) }),
      institucion_plus: clean({ usd_reference: v('pp-p-u'), eur_reference: v('pp-p-e') }),
      addons: {}, launch_offers: {},
    };
    document.querySelectorAll('#pf-pricing-card [data-addon]').forEach(el => { const x = el.value.trim() === '' ? undefined : Number(el.value); (p.addons[el.dataset.addon] = p.addons[el.dataset.addon] || {})[el.dataset.cur] = x; });
    document.querySelectorAll('#pf-pricing-card [data-offer]').forEach(el => { p.launch_offers[el.dataset.offer] = !!el.checked; });
    if (JSON.stringify(p).includes('null') || Object.values(p).some(o => Object.values(o).some(x => Number.isNaN(x)))) { showToast('Use numbers like 12 or 14.50.', 'err'); return; }
    btn.disabled = true;
    const { data, error } = await sb.rpc('update_plans', { p });
    btn.disabled = false;
    if (error) { showToast('Error: ' + dbErr(error.message), 'err'); return; }
    A.plans = J(data); if (A.overview?.settings) A.overview.settings.plans = A.plans;
    window.TCPlans?.loadPlans?.(true);
    showToast('Plans saved ✓', 'ok'); renderPlansCard();
  }

  // ── teacher plans (accounts without institution) ──
  async function loadIndividual() {
    const { data, error } = await sb.rpc('list_individual_plans');
    A.individual = error ? [] : (J(data) || []); renderIndividual(error);
  }
  function renderIndividual(error) {
    const box = $('pf-individual-card'); if (!box) return;
    const ST = { active: 'Active', pilot: 'Pilot', cancelled: 'Plan cancelled', none: 'Remove the plan' };
    if (!$('pf-ind-form')) { // the form is built once: a re-render of Platform never wipes what is being typed
      box.innerHTML = `<div class="admin-card-title">Teacher plans <span>Accounts without an institution · set by hand once they pay</span></div>
      <div class="bl-settings pf-indiv-form" id="pf-ind-form"><label class="bl-field"><span class="modal-label">Account e-mail</span><input type="email" id="pf-ind-email" class="settings-input" autocomplete="off"></label>
        <label class="bl-field"><span class="modal-label">Plan status</span><select id="pf-ind-status" class="settings-input">${Object.keys(ST).map(k => `<option value="${k}">${esc(tr(ST[k]))}</option>`).join('')}</select></label>
        <label class="bl-field"><span class="modal-label">Note</span><input type="text" id="pf-ind-note" class="settings-input" maxlength="500"></label></div>
      <div class="bl-row"><button class="btn-modal-save" data-pa="ind-save">Save Teacher plan</button> <span class="bl-hint">An active Teacher plan: no trial limit and the plan's classes per month.</span></div>
      <div id="pf-ind-table"></div>`;
    }
    $('pf-ind-table').innerHTML = error ? `<div class="bl-empty">${esc(dbErr(error.message))}</div>` : `<table class="teachers-table"><thead><tr><th>Account</th><th>Status</th><th>Since</th><th>Note</th></tr></thead><tbody id="pf-ind-list">${A.individual.length ? A.individual.map(x => `<tr><td data-no-i18n>${esc(x.name || '')}<div class="bl-sub">${esc(x.email)}</div></td><td>${esc(tr(ST[x.plan_status] || x.plan_status))}</td><td data-no-i18n>${esc(x.activated_at ? fmtD(x.activated_at, { year: 'numeric', month: 'short', day: 'numeric' }) : '—')}</td><td data-no-i18n>${esc(x.note || '')}</td></tr>`).join('') : '<tr><td colspan="4" class="muted-cell">No Teacher plans yet.</td></tr>'}</tbody></table>`;
  }
  async function saveIndividual(btn) {
    if (blocked()) return;
    const email = $('pf-ind-email').value.trim(); if (!email) { showToast('Enter an email.', 'err'); return; }
    btn.disabled = true;
    const { error } = await sb.rpc('set_individual_plan', { p_email: email, p_status: $('pf-ind-status').value, p_note: $('pf-ind-note').value });
    btn.disabled = false;
    if (error) { showToast('Error: ' + dbErr(error.message), 'err'); return; }
    showToast('Teacher plan saved ✓', 'ok'); $('pf-ind-email').value = ''; $('pf-ind-note').value = ''; loadIndividual();
  }

  // ── AI model per kind + mini prices ──
  function prices() {
    const s = A.overview?.settings || {};
    return { default: { in: Number(s.ai_price_input ?? 2.5), out: Number(s.ai_price_output ?? 10) }, mini: { in: Number(s.ai_price_input_mini ?? 0.4), out: Number(s.ai_price_output_mini ?? 1.6) } };
  }
  const cost = (m, pt, ct) => { const p = prices()[m]; return (pt * p.in + ct * p.out) / 1e6; };
  function renderModelsCard() {
    const box = $('pf-models-card'); if (!box) return;
    const s = A.overview?.settings || {}; const md = J(s.ai_model_default) || {}; const mini = A.status?.model_mini;
    const sel = k => `<label class="bl-field"><span class="modal-label">${esc(tr(KIND_L[k]))}</span><select class="settings-input" data-model-kind="${k}">
      <option value="default"${md[k] !== 'mini' ? ' selected' : ''}>${esc(tr('Default model'))}</option><option value="mini"${md[k] === 'mini' ? ' selected' : ''}>${esc(tr('Mini model'))}</option></select></label>`;
    box.innerHTML = `<div class="admin-card-title">AI model <span>Which Azure deployment each kind of request uses</span></div>
      ${mini === false ? `<div class="bl-banner warn" id="pf-mini-missing" role="status"><b>The mini model is not configured:</b> <span>add AZURE_OPENAI_DEPLOYMENT_MINI in Vercel (README → owner checklist). Until then "Mini model" uses the default deployment.</span></div>` : ''}
      <div class="bl-settings">${['main', 'student', 'summary', 'verify'].map(sel).join('')}</div>
      <div class="bl-row"><button class="btn-modal-save" data-pa="models-save">Save models</button> <span class="bl-hint">Decide with "Compare models" below first.</span></div>
      <div class="bl-subtitle">Mini model price <span class="bl-tag">to verify</span></div>
      <div class="bl-settings"><label class="bl-field"><span class="modal-label">Input tokens (USD per 1M)</span><input type="number" min="0" step="0.01" id="pf-mini-in" class="settings-input" value="${esc(s.ai_price_input_mini ?? 0.4)}"></label>
        <label class="bl-field"><span class="modal-label">Output tokens (USD per 1M)</span><input type="number" min="0" step="0.01" id="pf-mini-out" class="settings-input" value="${esc(s.ai_price_output_mini ?? 1.6)}"></label></div>
      <div class="bl-row"><button class="btn-modal-save" data-pa="mini-prices-save">Save mini prices</button> <span class="bl-hint">Defaults from the pricing proposal (gpt-4.1-mini 0.40 / 1.60, Oct 2026): check them against your Azure price sheet. The default model uses "AI cost estimate" above.</span></div>`;
  }
  async function saveModels(btn) {
    if (blocked()) return;
    const p = {}; document.querySelectorAll('#pf-models-card [data-model-kind]').forEach(el => { p[el.dataset.modelKind] = el.value; });
    btn.disabled = true;
    const { data, error } = await sb.rpc('update_ai_model_default', { p });
    btn.disabled = false;
    if (error) { showToast('Error: ' + dbErr(error.message), 'err'); return; }
    if (A.overview?.settings) A.overview.settings.ai_model_default = J(data);
    showToast('Models saved ✓', 'ok');
  }
  async function saveMiniPrices(btn) {
    if (blocked()) return;
    const a = $('pf-mini-in').value.trim(), b = $('pf-mini-out').value.trim(); const ok = x => /^\d+(\.\d{1,4})?$/.test(x) && Number(x) <= 1000;
    if (!ok(a) || !ok(b)) { showToast('Use a price between 0 and 1000, like 2.50.', 'err'); return; }
    btn.disabled = true;
    const { error } = await sb.rpc('update_ai_prices_mini', { p_input: Number(a), p_output: Number(b) });
    btn.disabled = false;
    if (error) { showToast('Error: ' + dbErr(error.message), 'err'); return; }
    if (A.overview?.settings) Object.assign(A.overview.settings, { ai_price_input_mini: Number(a), ai_price_output_mini: Number(b) });
    showToast('Prices saved ✓', 'ok'); renderCompare();
  }

  // ── compare models (blind) ──
  async function loadSummary() {
    const { data, error } = await sb.rpc('model_comparison_summary');
    A.summary = error ? null : J(data); renderCompare();
  }
  const sideOf = (pair, letter) => (letter === 'A' ? pair.left : (pair.left === 'mini' ? 'default' : 'mini'));
  function statHtml(r, m) {
    if (!r) return '';
    const c = cost(m, r.prompt_tokens, r.completion_tokens);
    return `<div class="pf-cmp-stats" data-no-i18n><span>⏱ ${esc(n2(r.ms / 1000))} s</span><span>🔤 ${esc(n2(r.prompt_tokens))} + ${esc(n2(r.completion_tokens))} tokens</span><span>💵 ≈ ${esc(usd(c))}</span></div>`;
  }
  function colHtml(letter) {
    const P = CMP.pair; const m = sideOf(P, letter); const r = P.res[m];
    const reveal = CMP.saved ? ` <span class="pf-cmp-model">= ${esc(tr(m === 'mini' ? 'Mini model' : 'Default model'))}${r?.deployment ? ` (${esc(r.deployment)})` : ''}</span>` : '';
    const body = r ? `${statHtml(r, m)}${r.fallback ? `<div class="bl-hint">${esc(tr('Mini not configured: this used the default deployment.'))}</div>` : ''}
        <div class="pf-cmp-h">Teacher guide</div><div class="pf-cmp-doc" data-no-i18n tabindex="0">${esc(r.guide)}</div>
        <div class="pf-cmp-h">Student handout</div><div class="pf-cmp-doc" data-no-i18n tabindex="0">${esc(r.handout)}</div>`
      : P.err?.[m] ? `<div class="bl-banner block" role="alert">${esc(P.err[m])}</div>` : `<div class="in-loading">${esc(tr('Generating…'))}</div>`;
    return `<div class="pf-cmp-col" data-side="${letter}"><div class="pf-cmp-title"><b>${esc(tr('Model'))} ${letter}</b>${reveal}</div>${body}</div>`;
  }
  function renderCompare() {
    const box = $('pf-compare-card'); if (!box) return;
    const S = A.summary; const mini = A.status?.model_mini;
    const cur = CMP.queue[CMP.idx];
    const queue = CMP.queue.length ? `<ol class="pf-cmp-queue">${CMP.queue.map((q, i) => `<li class="${i === CMP.idx ? 'cur' : ''}${q.done ? ' done' : ''}" data-no-i18n>${esc(q.title)}${q.done ? ' ✓' : ''}</li>`).join('')}</ol>` : '';
    const summary = S && S.total ? `<div class="metrics-grid pf-cmp-sum" id="pf-cmp-summary">
        <div class="metric-card"><div class="metric-label">Pairs rated</div><div class="metric-value" data-no-i18n>${esc(S.total)}</div><div class="metric-sub"><span>Ties</span> <span data-no-i18n>${esc(S.wins?.tie ?? 0)}</span></div></div>
        <div class="metric-card"><div class="metric-label">Default model wins</div><div class="metric-value" data-no-i18n>${esc(n2(S.win_rate?.default ?? 0))}%</div><div class="metric-sub" data-no-i18n>${esc(S.wins?.default ?? 0)} / ${esc(S.total)}</div></div>
        <div class="metric-card"><div class="metric-label">Mini model wins</div><div class="metric-value" data-no-i18n>${esc(n2(S.win_rate?.mini ?? 0))}%</div><div class="metric-sub" data-no-i18n>${esc(S.wins?.mini ?? 0)} / ${esc(S.total)}</div></div>
        <div class="metric-card"><div class="metric-label">Average cost per class</div><div class="metric-value pf-cmp-cost" data-no-i18n>${esc(usd(S.avg_usd?.default))} · ${esc(usd(S.avg_usd?.mini))}</div><div class="metric-sub">Default · Mini (prices at the time of each rating)</div></div></div>` : '<div class="bl-hint" id="pf-cmp-summary">No pairs rated yet.</div>';
    let pair = '';
    if (CMP.pair) {
      const P = CMP.pair; const both = P.res.default && P.res.mini;
      pair = `<div class="pf-cmp-pair-title"><span>Class:</span> <b data-no-i18n>${esc(P.title)}</b></div><div class="pf-cmp-cols">${colHtml('A')}${colHtml('B')}</div>
        ${both && !CMP.saved ? `<div class="pf-cmp-rate" role="group" aria-label="${esc(tr('Which one is better?'))}"><span class="modal-label">Which one is better?</span>
          ${[['a', 'A is better'], ['b', 'B is better'], ['tie', 'Same']].map(([v, l]) => `<button type="button" class="tree-btn${CMP.pick === v ? ' primary' : ''}" data-pa="cmp-pick" data-v="${v}" aria-pressed="${CMP.pick === v}">${esc(tr(l))}</button>`).join('')}
          <textarea id="pf-cmp-note" class="settings-input" rows="2" maxlength="1000" placeholder="${esc(tr('Note (optional): why?'))}" aria-label="${esc(tr('Note (optional): why?'))}"></textarea>
          <button type="button" class="btn-modal-save" data-pa="cmp-save"${CMP.pick ? '' : ' disabled'}>Save rating</button></div>` : ''}
        ${CMP.saved ? `<div class="bl-row"><span class="bl-badge approved">Rating saved</span>${CMP.idx < CMP.queue.length - 1 ? ' <button type="button" class="btn-modal-save" data-pa="cmp-next">Next class →</button>' : ''}</div>` : ''}`;
    }
    const recent = (S?.recent || []).slice(0, 10);
    box.innerHTML = `<div class="admin-card-title">Compare models <span>Blind test: the same class with both models, in random order</span></div>
      ${mini === false ? '<div class="bl-banner warn" role="status"><b>The mini model is not configured</b> <span>(AZURE_OPENAI_DEPLOYMENT_MINI): both sides would use the default deployment.</span></div>' : ''}
      <div class="bl-hint">Each pair runs the full pipeline (teacher guide, continuation, calculation check, student handout) through /api/generate with the default and the mini deployment. Model names stay hidden until you rate. Uses your own daily AI limit.</div>
      <div class="pf-cmp-src">
        <div class="bl-settings"><label class="bl-field pf-cmp-topic"><span class="modal-label">Topic</span><input type="text" id="pf-cmp-topic" class="settings-input" maxlength="300" placeholder="${esc(tr('e.g. Photosynthesis for 2nd year'))}"></label></div>
        <div class="bl-row"><button type="button" class="tree-btn" data-pa="cmp-add-topic">＋ Add with the generator's settings</button>
          <button type="button" class="tree-btn" data-pa="cmp-load">⤓ Load the last 20 saved classes</button>
          ${CMP.queue.length ? '<button type="button" class="tree-btn" data-pa="cmp-clear">Clear list</button>' : ''}</div>
        ${queue}
        <div class="bl-row"><button type="button" class="btn-modal-save" data-pa="cmp-run"${!cur || CMP.running || (CMP.pair && !CMP.saved && CMP.pair.title === cur.title) ? ' disabled' : ''}>${esc(tr(CMP.running ? 'Generating…' : 'Compare this class'))}</button> ${CMP.error ? `<span class="bl-hint pf-err">${esc(CMP.error)}</span>` : ''}</div>
      </div>
      <div id="pf-cmp-pair">${pair}</div>
      <div class="bl-subtitle">Summary</div>${summary}
      ${recent.length ? `<table class="teachers-table"><thead><tr><th>Date</th><th>Class</th><th>Winner</th><th>Cost (default · mini)</th><th>Note</th></tr></thead><tbody id="pf-cmp-recent">${recent.map(r => `<tr><td data-no-i18n>${esc(fmtD(r.created_at, { month: 'short', day: 'numeric' }))}</td><td data-no-i18n>${esc(r.title)}</td><td>${esc(tr(r.winner === 'tie' ? 'Same' : r.winner === 'mini' ? 'Mini model' : 'Default model'))}</td><td data-no-i18n>${esc(usd(r.results?.default?.usd))} · ${esc(usd(r.results?.mini?.usd))}</td><td data-no-i18n>${esc(r.note || '')}</td></tr>`).join('')}</tbody></table>` : ''}`;
  }
  function addTopic() {
    const topic = $('pf-cmp-topic').value.trim(); const base = window.TCCurrentParams?.() || null;
    if (!topic && !base) { showToast('Write a topic (or one in the class generator) first.', 'err'); return; }
    const params = base ? { ...base, ...(topic ? { prompt: topic } : {}) } : { prompt: topic, language: lang() === 'es' ? 'Spanish' : 'English', level: 'Secondary', age: '', groupSize: '25', duration: '60 min', subjects: [], skills: [] };
    CMP.queue.push({ title: params.prompt.slice(0, 120), params }); if (CMP.queue.length === 1) CMP.idx = 0;
    $('pf-cmp-topic').value = ''; renderCompare();
  }
  async function loadSaved() {
    const { data, error } = await sb.from('plannings').select('id,title,data,created_at').order('created_at', { ascending: false }).limit(20);
    if (error) { showToast('Error: ' + dbErr(error.message), 'err'); return; }
    const items = (data || []).filter(p => p?.data?.params?.prompt).map(p => ({ title: String(p.title || p.data.params.prompt).slice(0, 120), params: p.data.params }));
    if (!items.length) { showToast('No saved classes with their settings yet.', 'err'); return; }
    CMP.queue = items.slice(0, 20); CMP.idx = 0; CMP.pair = null; CMP.saved = false; renderCompare();
    showToast(`${items.length} ${tr(items.length === 1 ? 'class loaded' : 'classes loaded')}`, 'ok');
  }
  async function runPair() {
    const cur = CMP.queue[CMP.idx]; if (!cur || CMP.running) return;
    if (!window.TCGenerateFull) { showToast('Reload the page and try again.', 'err'); return; }
    CMP.running = true; CMP.error = ''; CMP.saved = false; CMP.pick = null;
    CMP.pair = { title: cur.title, params: cur.params, left: Math.random() < 0.5 ? 'mini' : 'default', res: {}, err: {} };
    renderCompare();
    const order = [sideOf(CMP.pair, 'A'), sideOf(CMP.pair, 'B')];
    for (const m of order) {
      try { CMP.pair.res[m] = await window.TCGenerateFull(cur.params, m); }
      catch (e) { CMP.pair.err[m] = String(e?.message || e); }
      renderCompare();
    }
    CMP.running = false;
    if (CMP.pair.err.default || CMP.pair.err.mini) CMP.error = tr('One of the models failed: try this class again.');
    renderCompare();
  }
  async function savePair(btn) {
    if (blocked() || !CMP.pair || !CMP.pick) return;
    const P = CMP.pair; const strip = r => ({ ms: r.ms, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, deployment: r.deployment || '', fallback: !!r.fallback });
    btn.disabled = true;
    const { error } = await sb.rpc('save_model_comparison', { p: { title: P.title, params: P.params, left_model: P.left, winner: CMP.pick, note: $('pf-cmp-note')?.value || '',
      results: { default: strip(P.res.default), mini: strip(P.res.mini) },
      texts: { default: { guide: P.res.default.guide, handout: P.res.default.handout }, mini: { guide: P.res.mini.guide, handout: P.res.mini.handout } } } });
    btn.disabled = false;
    if (error) { showToast('Error: ' + dbErr(error.message), 'err'); return; }
    CMP.saved = true; if (CMP.queue[CMP.idx]) CMP.queue[CMP.idx].done = true;
    showToast('Rating saved ✓', 'ok');
    await loadSummary();
  }

  document.addEventListener('click', e => {
    const el = e.target.closest?.('[data-pa]'); if (!el) return;
    switch (el.dataset.pa) {
      case 'lead-filter': A.filter = el.dataset.v; renderLeads(); break;
      case 'lead-csv': leadsCsv(); break;
      case 'lead-save': saveLead(el.dataset.id, el); break;
      case 'plans-save': savePlans(el); break;
      case 'ind-save': saveIndividual(el); break;
      case 'models-save': saveModels(el); break;
      case 'mini-prices-save': saveMiniPrices(el); break;
      case 'cmp-add-topic': addTopic(); break;
      case 'cmp-load': loadSaved(); break;
      case 'cmp-clear': CMP.queue = []; CMP.idx = 0; CMP.pair = null; renderCompare(); break;
      case 'cmp-run': runPair(); break;
      case 'cmp-pick': CMP.pick = el.dataset.v; { const note = $('pf-cmp-note')?.value || ''; renderCompare(); const n = $('pf-cmp-note'); if (n) n.value = note; } break;
      case 'cmp-save': savePair(el); break;
      case 'cmp-next': CMP.idx = Math.min(CMP.idx + 1, CMP.queue.length - 1); CMP.pair = null; CMP.saved = false; renderCompare(); runPair(); break;
    }
  });

  window.TCPlansAdmin = { render, refreshBadge, _A: A, _CMP: CMP };

  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'new sales request': 'pedido de ventas nuevo', 'new sales requests': 'pedidos de ventas nuevos',
    'Sales requests': 'Pedidos de ventas', '"Talk to sales" from the app and the plans page': '"Hablar con ventas" desde la app y la página de planes',
    'E-mail notifications are off: add RESEND_API_KEY and SALES_NOTIFY_EMAIL in Vercel to get an e-mail for each request. Until then they only show here (with a badge on Platform).':
      'Los avisos por email están apagados: agregá RESEND_API_KEY y SALES_NOTIFY_EMAIL en Vercel para recibir un email por cada pedido. Mientras tanto aparecen solo acá (con un globito en Plataforma).',
    All: 'Todos', New: 'Nuevo', Contacted: 'Contactado', Won: 'Ganado', Lost: 'Perdido', Status: 'Estado', Notes: 'Notas', 'PH:Notes': 'Notas',
    Person: 'Persona', Contact: 'Contacto', Request: 'Pedido', Message: 'Mensaje', 'Status & notes': 'Estado y notas', Date: 'Fecha',
    Leadership: 'Dirección', 'Academic coordination': 'Coordinación académica', Teacher: 'Docente', Administration: 'Administración', Other: 'Otro',
    'Account:': 'Cuenta:', classes: 'clases', 'Without an account (verified with Turnstile)': 'Sin cuenta (verificado con Turnstile)',
    'Prefers WhatsApp': 'Prefiere WhatsApp', 'Prefers e-mail': 'Prefiere email', Institution: 'Institución', 'Institution+': 'Institución+', 'Not sure yet': 'Todavía no sabe',
    teachers: 'docentes', 'Pop-up (2nd class)': 'Pop-up (2ª clase)', 'Reminder (4th class)': 'Recordatorio (4ª clase)', 'Trial limit': 'Límite de la prueba',
    'Plans page': 'Página de planes', 'Plan & usage': 'Plan y consumo', 'No requests with this status.': 'No hay pedidos con este estado.', 'No sales requests yet.': 'Todavía no hay pedidos de ventas.',
    Save: 'Guardar', 'Request updated ✓': 'Pedido actualizado ✓',
    'Plans & pricing': 'Planes y precios', 'What the plans page and the pop-ups show ·': 'Lo que muestran la página de planes y los pop-ups ·',
    'Run the new supabase/migrations/001_base.sql to edit the plans.': 'Ejecutá el nuevo supabase/migrations/001_base.sql para editar los planes.',
    'Free trial': 'Prueba gratis', 'Classes in the trial (total)': 'Clases de la prueba (en total)', 'Pop-up after class': 'Pop-up después de la clase', 'Reminder after class': 'Recordatorio después de la clase',
    'Watermark on trial PDFs': 'Marca de agua en los PDF de la prueba', 'Teacher (individual)': 'Docente (individual)', 'USD per month': 'USD por mes', 'USD per year': 'USD por año',
    'EUR per month (VAT incl.)': 'EUR por mes (IVA incl.)', 'EUR per year (VAT incl.)': 'EUR por año (IVA incl.)', 'Classes per month': 'Clases por mes', 'Classroom hours per month': 'Horas de aula por mes',
    'Institution (per teacher per month)': 'Institución (por docente por mes)', Teachers: 'Docentes', 'USD yearly': 'USD anual', 'USD monthly': 'USD mensual', 'EUR yearly': 'EUR anual', 'EUR monthly': 'EUR mensual',
    'Classes per teacher per month': 'Clases por docente por mes', 'Classroom hours per teacher': 'Horas de aula por docente', 'Analyzed classes per teacher': 'Clases analizadas por docente',
    'Institution+: reference USD': 'Institución+: referencia USD', 'Institution+: reference EUR': 'Institución+: referencia EUR', 'Packs and add-ons': 'Packs y extras', 'Add-on': 'Extra',
    'Launch offers': 'Ofertas de lanzamiento',
    'They show on the plans page only when switched on. No countdowns or invented scarcity: "places left" only appears when real accounts already have the Founding plan.':
      'Se muestran en la página de planes solo si están encendidas. Sin cuentas regresivas ni escasez inventada: "quedan N lugares" aparece solo cuando hay cuentas reales con el plan Fundadoras.',
    'Founding Institutions (30% off year 1, first 10)': 'Instituciones Fundadoras (30% menos el 1er año, las primeras 10)', '60-day pilot (USD 150, up to 10 teachers)': 'Piloto 60 días (USD 150, hasta 10 docentes)',
    '6-month ANII pilot': 'Piloto ANII 6 meses', 'TERO20 coupon (20% off yearly Teacher)': 'Cupón TERO20 (20% menos en Docente anual)',
    'Save plans': 'Guardar planes', 'Changes apply at once (plans page, pop-ups, trial limit).': 'Los cambios valen enseguida (página de planes, pop-ups, límite de la prueba).',
    'Use numbers like 12 or 14.50.': 'Usá números como 12 o 14.50.', 'Plans saved ✓': 'Planes guardados ✓',
    'Teacher plans': 'Planes Docente', 'Accounts without an institution · set by hand once they pay': 'Cuentas sin institución · se activa a mano cuando pagan',
    'Account e-mail': 'Email de la cuenta', 'Plan status': 'Estado del plan', Note: 'Nota', Active: 'Activo', Pilot: 'Piloto', 'Plan cancelled': 'Plan cancelado', 'Remove the plan': 'Quitar el plan',
    'Save Teacher plan': 'Guardar plan Docente', "An active Teacher plan: no trial limit and the plan's classes per month.": 'Un plan Docente activo: sin límite de prueba y con las clases por mes del plan.',
    Account: 'Cuenta', Since: 'Desde', 'No Teacher plans yet.': 'Todavía no hay planes Docente.', 'Teacher plan saved ✓': 'Plan Docente guardado ✓', 'Enter an email.': 'Ingresá un email.',
    'Class (guide + continuation)': 'Clase (guía + continuación)', 'Student handout': 'Material del alumno', 'Playbook summary': 'Resumen del playbook', 'Calculation check': 'Chequeo de cálculos',
    'Default model': 'Modelo por defecto', 'Mini model': 'Modelo mini', 'AI model': 'Modelo de IA', 'Which Azure deployment each kind of request uses': 'Qué despliegue de Azure usa cada tipo de pedido',
    'The mini model is not configured:': 'El modelo mini no está configurado:',
    'add AZURE_OPENAI_DEPLOYMENT_MINI in Vercel (README → owner checklist). Until then "Mini model" uses the default deployment.': 'agregá AZURE_OPENAI_DEPLOYMENT_MINI en Vercel (README → checklist del dueño). Mientras tanto "Modelo mini" usa el despliegue por defecto.',
    'Save models': 'Guardar modelos', 'Decide with "Compare models" below first.': 'Primero decidí con "Comparar modelos", acá abajo.', 'Mini model price': 'Precio del modelo mini', 'to verify': 'por verificar',
    'Input tokens (USD per 1M)': 'Tokens de entrada (USD por 1M)', 'Output tokens (USD per 1M)': 'Tokens de salida (USD por 1M)', 'Save mini prices': 'Guardar precios del mini',
    'Defaults from the pricing proposal (gpt-4.1-mini 0.40 / 1.60, Oct 2026): check them against your Azure price sheet. The default model uses "AI cost estimate" above.':
      'Valores de la propuesta de pricing (gpt-4.1-mini 0,40 / 1,60, oct 2026): verificalos con la lista de precios de Azure. El modelo por defecto usa "Estimación de costo de IA", más arriba.',
    'Models saved ✓': 'Modelos guardados ✓', 'Prices saved ✓': 'Precios guardados ✓', 'Use a price between 0 and 1000, like 2.50.': 'Usá un precio entre 0 y 1000, como 2.50.',
    'Compare models': 'Comparar modelos', 'Blind test: the same class with both models, in random order': 'Prueba ciega: la misma clase con los dos modelos, en orden al azar',
    'The mini model is not configured': 'El modelo mini no está configurado', '(AZURE_OPENAI_DEPLOYMENT_MINI): both sides would use the default deployment.': '(AZURE_OPENAI_DEPLOYMENT_MINI): los dos lados usarían el despliegue por defecto.',
    'Each pair runs the full pipeline (teacher guide, continuation, calculation check, student handout) through /api/generate with the default and the mini deployment. Model names stay hidden until you rate. Uses your own daily AI limit.':
      'Cada par corre todo el proceso (guía docente, continuación, chequeo de cálculos, material del alumno) por /api/generate con el despliegue por defecto y con el mini. Los nombres de los modelos quedan ocultos hasta que califiques. Usa tu propio límite diario de IA.',
    Topic: 'Tema', 'PH:e.g. Photosynthesis for 2nd year': 'Ej.: Fotosíntesis para 2º año', "＋ Add with the generator's settings": '＋ Agregar con los ajustes del generador',
    '⤓ Load the last 20 saved classes': '⤓ Cargar las últimas 20 clases guardadas', 'Clear list': 'Vaciar la lista', 'Compare this class': 'Comparar esta clase', 'Generating…': 'Generando…',
    'Class:': 'Clase:', Model: 'Modelo', 'Teacher guide': 'Guía docente', 'Mini not configured: this used the default deployment.': 'Mini sin configurar: se usó el despliegue por defecto.',
    'Which one is better?': '¿Cuál es mejor?', 'A is better': 'A es mejor', 'B is better': 'B es mejor', Same: 'Igual', 'Note (optional): why?': 'Nota (opcional): ¿por qué?', 'PH:Note (optional): why?': 'Nota (opcional): ¿por qué?',
    'Save rating': 'Guardar calificación', 'Rating saved': 'Calificación guardada', 'Rating saved ✓': 'Calificación guardada ✓', 'Next class →': 'Clase siguiente →',
    Summary: 'Resumen', 'Pairs rated': 'Pares calificados', Ties: 'Empates', 'Default model wins': 'Gana el modelo por defecto', 'Mini model wins': 'Gana el modelo mini', 'Average cost per class': 'Costo promedio por clase',
    'Default · Mini (prices at the time of each rating)': 'Por defecto · Mini (precios del momento de cada calificación)', 'No pairs rated yet.': 'Todavía no hay pares calificados.',
    Class: 'Clase', Winner: 'Ganador', 'Cost (default · mini)': 'Costo (por defecto · mini)',
    'Write a topic (or one in the class generator) first.': 'Escribí un tema (o uno en el generador de clases) primero.', 'No saved classes with their settings yet.': 'Todavía no hay clases guardadas con sus ajustes.',
    'class loaded': 'clase cargada', 'classes loaded': 'clases cargadas', 'Reload the page and try again.': 'Recargá la página y probá de nuevo.',
    'One of the models failed: try this class again.': 'Uno de los modelos falló: probá esta clase de nuevo.',
  });
})();
