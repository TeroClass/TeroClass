/* TeroClass · Group notebook ("Cuaderno del grupo"): one shared notebook per group and school year
 * ------------------------------------------------------------------------------------------
 * One rich-text notebook per group and school year with ONE SECTION PER CLASS ("Class 12 · Mon 3 Mar", in date order) and
 * an outline to jump between them. Teacher, substitute and the group's students write live (same engine as the class
 * document: TipTap 2 + Yjs, public/vendor/classdoc-editor.js); institution admins and the super admin read only.
 * The teacher can lock the whole notebook or only the past classes, add today's section, paste a class (student handout,
 * never the answers) into the current section, keep teacher-only notes (the teacher guide) and restore versions.
 * Export: the whole notebook or one section (print / PDF, HTML, Markdown).
 * Also here: "Send to the group notebook" from the generator (student handout → a class section; teacher guide → a
 * teacher-only note), and the live-room / calendar entry points (a class of a group → its notebook section; a one-off class
 * without a group keeps its own class document: public/class-doc.js).
 *
 * Sync (all access checked in the database: supabase/migrations/001_base.sql, "CUADERNO DEL GRUPO"):
 *   · each section is its own Yjs document: every local change → notebook_push (section + Yjs update, base64); changes are
 *     read with notebook_pull (ordered ids per notebook; a section compacted with notebook_snapshot comes back as a photo);
 *   · Supabase Realtime PRIVATE channel "notebook:<notebook id>" only carries "changes, pull" pokes and cursor positions,
 *     never content. Fallback: a public channel with an unguessable name (same rule); without Realtime: pull every 2 s.
 * Names / colours of the people in the notebook come from the database (never from other browsers).
 * Depends on globals from index.html: sb, viewAs, esc, showToast, trText, uiLang, uiLocale, I18N_ES, DB_ERRORS, dbErr,
 * plannings, loadPlannings, formatDoc, cleanStudentHandout, vaBlocked, currentResult; and on window.TCClassDoc (helpers).
 */
(function () {
  'use strict';

  const EDITOR_URL = '/vendor/classdoc-editor.js';
  const REMOTE = 'tc-remote';
  const POLL_MS = 2000, POLL_RT_MS = 15000, POLL_HIDDEN_MS = 8000;
  const SNAP_EVERY = 40, SNAP_IDLE_MS = 30000;
  const MAX_BYTES = 8388608;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const toast = (m, t, ms) => { if (typeof showToast === 'function') showToast(m, t, ms); };
  const dbMsg = m => (typeof dbErr === 'function' ? dbErr(String(m || '')) : String(m || ''));
  const inViewAs = () => typeof viewAs !== 'undefined' && !!viewAs;
  const H = s => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const loc = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  const lang = () => (typeof uiLang !== 'undefined' && uiLang === 'es' ? 'es' : 'en');
  const fDT = d => { try { return new Date(d).toLocaleString(loc(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(lang() === 'es' ? { hourCycle: 'h23' } : {}) }); } catch (e) { return ''; } };
  // "lun 3 mar" / "Mon, Mar 3" in the group's time zone
  const fDay = (d, tz) => { try { return new Date(d).toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz || undefined }).replace(/\./g, '').replace(lang() === 'es' ? /,/g : /^$/, ''); } catch (e) { return ''; } };
  const initials = n => (String(n || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
  const safeColor = c => (COLOR_RE.test(String(c || '')) ? c : '#7c5cbf');
  const fmtMB = b => (Math.round((Number(b) || 0) / 104857.6) / 10).toLocaleString(loc());
  const newCid = () => { const a = new Uint32Array(1); (window.crypto || {}).getRandomValues?.(a); return (a[0] % 2000000000) + 1000 || Math.floor(Math.random() * 2e9) + 1000; };
  const handoutToHtml = (text, title) => (window.TCClassDoc && window.TCClassDoc.handoutToHtml ? window.TCClassDoc.handoutToHtml(text, title) : `<p>${H(text)}</p>`);
  const toMarkdown = doc => (window.TCClassDoc && window.TCClassDoc.toMarkdown ? window.TCClassDoc.toMarkdown(doc) : '');

  let modP = null;
  const loadEditor = () => (modP = modP || (window.TCClassDoc && window.TCClassDoc.loadEditor ? window.TCClassDoc.loadEditor() : import(EDITOR_URL)).catch(e => { modP = null; throw e; }));

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args || {});
    let d = data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* keep */ } }
    return { data: d, error };
  }
  function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function fromB64(b) { const s = atob(String(b || '')); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  // a section's label: "Class 12 · Mon 3 Mar" (a class) or its title / "Notes · date" (a section without a class)
  function secLabel(s, tz) {
    const day = fDay(s.starts_at, s.timezone || tz);
    if (s.kind === 'session' && s.number) return `${tr('Class')} ${s.number} · ${day}`;
    if (s.kind === 'session') return `${tr('Class')} · ${day}`;
    return `${s.title || tr('Notes')} · ${day}`;
  }
  const EXT = M => [
    M.StarterKit.configure({ history: false, heading: { levels: [1, 2, 3] } }),
    M.Link.configure({ openOnClick: false, autolink: true, protocols: ['mailto'], HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } }),
    M.Table.configure({ resizable: false }), M.TableRow, M.TableHeader, M.TableCell,
  ];

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // NotebookView: one open notebook (full-screen overlay or the live-class side panel)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  let seq = 0;
  class NotebookView {
    constructor(host, notebookId, opts = {}) {
      this.host = host; this.nb = notebookId; this.opts = opts; this.id = 'nb' + (++seq);
      this.cid = newCid();
      this.secs = new Map(); this.order = []; this.after = 0; this.gen = 1; this.known = -1;
      this.pushing = false; this.pulling = false; this.pullAgain = false;
      this.rt = null; this.channel = null; this.timers = {}; this.remote = new Map(); this.rtCursors = new Map();
      this.active = null; this.dead = false; this.status = 'loading'; this.notes = null;
      this.onVis = () => this.schedulePull(50);
      this.onClick = e => this.click(e);
      this.onChange = e => this.change(e);
      this.onDown = e => { if (e.target.closest('.cd-tb')) e.preventDefault(); };
    }
    get isTeacher() { return this.info?.role === 'teacher' && !inViewAs(); }
    get participant() { return (this.info?.role === 'teacher' || this.info?.role === 'student') && !inViewAs(); }
    get tz() { return this.info?.notebook?.timezone; }
    canEditSec(s) {
      const i = this.info; if (!i || inViewAs() || !s) return false;
      if (i.role === 'teacher') return true;
      if (i.role !== 'student' || i.locked) return false;
      return !(i.lock_past && s.meta.past);
    }

    async init() {
      this.host.innerHTML = `<div class="cd-shell nb-shell${this.opts.compact ? ' compact' : ''}" id="${this.id}"><div class="cd-loading">${H(tr('Opening the group notebook…'))}</div></div>`;
      this.host.addEventListener('click', this.onClick);
      this.host.addEventListener('change', this.onChange);
      this.host.addEventListener('mousedown', this.onDown);
      let M, res;
      try { [M, res] = await Promise.all([loadEditor(), rpc('notebook_open', { p_notebook: this.nb })]); }
      catch (e) { console.warn('notebook editor', e); return this.fail(tr('Could not load the editor. Check your connection and try again.')); }
      if (this.dead) return null;
      if (res.error || !res.data) return this.fail(/No autorizado/.test(res.error?.message || '') ? tr("You don't have access to this notebook.") : tr('Could not open the notebook.') + ' ' + (res.error?.message || ''));
      this.M = M; this.info = res.data;
      this.renderShell();
      this.load(res.data);
      document.addEventListener('visibilitychange', this.onVis);
      this.connectRealtime();
      this.schedulePull(this.participant ? 300 : 1500);
      this.updateUi();
      if (this.isTeacher) this.loadNotes();
      requestAnimationFrame(() => this.jump(this.opts.section || this.defaultSection(), false));
      return this;
    }
    fail(msg) {
      this.status = 'error';
      this.host.innerHTML = `<div class="cd-shell nb-shell${this.opts.compact ? ' compact' : ''}"><div class="cd-fail" role="alert"><span aria-hidden="true">📒</span><p data-no-i18n>${H(msg)}</p>${this.opts.compact ? '' : `<button type="button" class="tree-btn" data-nb="close">${H(tr('Close'))}</button>`}</div></div>`;
      return null;
    }
    defaultSection() { // today's section, else the last one before today, else the first
      const today = this.info?.today; const list = this.order.map(id => this.secs.get(id).meta);
      const t = list.find(s => s.day === today); if (t) return t.id;
      const before = list.filter(s => s.day && s.day < today); if (before.length) return before[before.length - 1].id;
      return list[0]?.id || null;
    }

    // ── sections: Yjs documents + editors ──
    load(p) {
      this.gen = p.generation || 1;
      this.known = (p.sections || []).length;
      this.after = 0;
      (p.sections || []).forEach(m => { this.after = Math.max(this.after, Number(m.upto) || 0); });
      this.syncSections(p.sections || []);
      const { Y } = this.M;
      (p.sections || []).forEach(m => { const s = this.secs.get(m.id); if (s && m.state) Y.applyUpdate(s.ydoc, fromB64(m.state), REMOTE); });
      (p.updates || []).forEach(u => this.applyUpdate(u, true));
    }
    makeSection(meta) {
      const { Y, Awareness } = this.M;
      const ydoc = new Y.Doc(); ydoc.clientID = this.cid;
      const aw = new Awareness(ydoc);
      const s = { meta, ydoc, aw, editor: null, pending: [], sinceSnap: 0, dirty: false, lastSnap: Date.now() };
      ydoc.on('update', (u, origin) => { if (origin !== REMOTE && !this.dead) { s.pending.push(u); s.dirty = true; this.schedulePush(); } });
      aw.on('change', (ch, origin) => { if (origin === 'local') this.localCursorChanged(s); });
      return s;
    }
    // add new sections / update their metadata, keep them in date order in the page and the outline
    syncSections(list) {
      const page = this.host.querySelector('.nb-sections'); if (!page) return;
      list.forEach(m => {
        let s = this.secs.get(m.id);
        if (!s) { s = this.makeSection(m); this.secs.set(m.id, s); }
        else s.meta = { ...s.meta, ...m, state: undefined };
      });
      this.order = list.map(m => m.id).filter(id => this.secs.has(id));
      [...this.secs.keys()].forEach(id => { if (!this.order.includes(id)) this.order.push(id); });
      this.order.forEach(id => {
        const s = this.secs.get(id);
        if (!s.el) { s.el = this.sectionEl(s); }
        page.appendChild(s.el); // keeps the editor; just moves the node into date order
        if (!s.editor) this.createEditor(s);
        this.renderSectionHead(s);
      });
      this.renderOutline();
      this.updateEmpty();
    }
    sectionEl(s) {
      const el = document.createElement('section'); el.className = 'nb-sec'; el.id = `${this.id}-sec-${s.meta.id}`; el.dataset.sec = s.meta.id;
      el.innerHTML = `<header class="nb-sec-h"></header><div class="cd-editor nb-editor" data-no-i18n></div><div class="nb-notes" hidden></div>`;
      return el;
    }
    renderSectionHead(s) {
      const m = s.meta; const i = this.info; const h = s.el.querySelector('.nb-sec-h'); if (!h) return;
      const today = m.day && m.day === i.today; const ro = !this.canEditSec(s);
      const sub = m.kind === 'session' && m.title ? `<span class="nb-sec-sub" data-no-i18n>${H(m.title)}</span>` : '';
      h.innerHTML = `<div class="nb-sec-titles"><h2 class="nb-sec-title" data-no-i18n>${H(secLabel(m, this.tz))}</h2>${sub}</div>
        <div class="nb-sec-tags">${today ? `<span class="nb-today">${H(tr('Today'))}</span>` : ''}${ro && i.role === 'student' && (i.locked || (i.lock_past && m.past)) ? `<span class="gc-chip warn">🔒 ${H(tr('Read-only'))}</span>` : ''}
          ${m.legacy_doc ? `<button type="button" class="tree-btn nb-legacy" data-nb="legacy" data-session="${H(m.session_id)}">📄 <span>${H(tr('Previous document of this class'))}</span></button>` : ''}
          ${m.legacy_doc && this.isTeacher ? `<button type="button" class="tree-btn" data-nb="import" data-sec="${H(m.id)}">⤵ <span>${H(tr('Import the previous document into this section'))}</span></button>` : ''}</div>`;
      s.el.classList.toggle('today', !!today);
      s.el.classList.toggle('ro', ro);
    }
    createEditor(s) {
      const M = this.M; const me = this.info.me || { name: tr('Reader'), color: '#888888' };
      const edit = this.canEditSec(s);
      s.editor = new M.Editor({
        element: s.el.querySelector('.nb-editor'), editable: edit,
        extensions: [...EXT(M),
          M.Placeholder.configure({ placeholder: tr(edit ? 'Write here… Everyone in the group sees it as you type.' : 'Nothing written in this class yet.') }),
          M.Collaboration.configure({ document: s.ydoc }),
          M.CollaborationCursor.configure({ provider: { awareness: s.aw }, user: { name: me.name, color: safeColor(me.color) } })],
        editorProps: { attributes: { class: 'cd-prose nb-prose', 'aria-label': secLabel(s.meta, this.tz), spellcheck: 'true' } },
        onFocus: () => { this.active = s.meta.id; this.updateToolbar(); this.markOutline(); },
        onTransaction: () => { if (this.active === s.meta.id) this.updateToolbar(); },
      });
      if (!this.participant) s.aw.setLocalState(null);
    }
    destroySections() {
      this.secs.forEach(s => { try { s.editor?.destroy(); } catch (e) { /* ignore */ } try { s.aw?.destroy(); } catch (e) { /* ignore */ } try { s.ydoc?.destroy(); } catch (e) { /* ignore */ } s.el?.remove(); });
      this.secs.clear(); this.order = [];
    }
    rebuild(p, why) { // generation changed (version restored) or a lock with unsent changes: start again from the server
      const keep = this.active;
      this.destroySections(); this.remote.clear(); this.rtCursors.clear();
      this.cid = newCid();
      this.info = { ...this.info, ...p };
      this.load(p); this.updateUi(); if (this.isTeacher) this.renderNotes();
      if (keep && this.secs.has(keep)) this.active = keep;
      if (why === 'restore') toast(tr('A previous version of the notebook was restored.'), 'ok', 4500);
    }
    applyUpdate(u, initial) {
      const { Y } = this.M;
      let s = this.secs.get(u.s);
      if (!s) { this.known = -1; this.schedulePull(60); s = this.makeSection({ id: u.s, kind: 'free', day: null }); this.secs.set(u.s, s); } // a section not listed yet
      if (initial || String(u.c) !== String(this.cid)) { Y.applyUpdate(s.ydoc, fromB64(u.d), REMOTE); if (!initial) s.sinceSnap++; }
      this.after = Math.max(this.after, Number(u.id) || 0);
    }

    // ── shell ──
    renderShell() {
      const n = this.info.notebook || {}; const c = !!this.opts.compact;
      const tb = (k, label, ico) => `<button type="button" class="cd-tb" data-nb="fmt" data-k="${k}" title="${H(tr(label))}" aria-label="${H(tr(label))}">${ico}</button>`;
      const years = Array.isArray(n.years) && n.years.length > 1 ? `<label class="sr-only" for="${this.id}-year">${H(tr('School year'))}</label><select id="${this.id}-year" class="nb-year-sel" data-nb-change="year">${n.years.map(y => `<option value="${H(y)}"${Number(y) === Number(n.year) ? ' selected' : ''} data-no-i18n>${H(y)}</option>`).join('')}</select>` : '';
      this.host.querySelector('.nb-shell').innerHTML = `
        <header class="cd-head">
          <div class="cd-head-main">
            ${c ? '' : `<div class="cd-kicker"><span aria-hidden="true">📒</span> <span>Group notebook</span></div>`}
            <div class="cd-title"><span>Notebook</span> · <span data-no-i18n>${H(n.group_name || '')} · ${H(n.year_label || n.year || '')}</span></div>
            <div class="cd-meta">${n.teacher_name ? `<span>Teacher:</span> <span data-no-i18n>${H(n.teacher_name)}</span> · ` : ''}<span>One section per class; everyone in the group writes in it.</span> ${years}</div>
          </div>
          <div class="cd-people" aria-label="${H(tr('People in the notebook'))}"></div>
          <div class="cd-status" role="status" aria-live="polite" data-no-i18n></div>
          <div class="cd-actions">
            <div class="cd-menu-wrap nb-lock-wrap" hidden><button type="button" class="tree-btn cd-lock" data-nb="lock-menu" aria-haspopup="true" aria-expanded="false"></button>
              <div class="cd-menu nb-lock-menu" role="menu" hidden>
                <button type="button" role="menuitemradio" data-nb="lock" data-mode="all">🔒 <span>Lock the whole notebook for students</span></button>
                <button type="button" role="menuitemradio" data-nb="lock" data-mode="past">🗓 <span>Lock only past classes</span></button>
                <button type="button" role="menuitemradio" data-nb="lock" data-mode="none">🔓 <span>Unlock for students</span></button>
              </div></div>
            <button type="button" class="tree-btn" data-nb="today" hidden>➕ <span>Add today's section</span></button>
            <button type="button" class="tree-btn" data-nb="paste" hidden>🎒 <span>Paste a class</span></button>
            <button type="button" class="tree-btn" data-nb="history">🕘 <span>History</span></button>
            <div class="cd-menu-wrap"><button type="button" class="tree-btn" data-nb="export-menu" aria-haspopup="true" aria-expanded="false">⬇ <span>Export</span></button>
              <div class="cd-menu nb-export-menu" role="menu" hidden>
                <div class="nb-menu-h">Whole notebook</div>
                <button type="button" role="menuitem" data-nb="print" data-scope="all">🖨 <span>Print / PDF</span></button>
                <button type="button" role="menuitem" data-nb="dl-html" data-scope="all">⬇ <span>Download HTML</span></button>
                <button type="button" role="menuitem" data-nb="dl-md" data-scope="all">⬇ <span>Download Markdown</span></button>
                <div class="nb-menu-h">This section</div>
                <button type="button" role="menuitem" data-nb="print" data-scope="one">🖨 <span>Print / PDF</span></button>
                <button type="button" role="menuitem" data-nb="dl-html" data-scope="one">⬇ <span>Download HTML</span></button>
                <button type="button" role="menuitem" data-nb="dl-md" data-scope="one">⬇ <span>Download Markdown</span></button>
              </div></div>
            ${c ? '' : `<button type="button" class="tree-btn cd-close" data-nb="close" aria-label="${H(tr('Close'))}">✕ <span>Close</span></button>`}
          </div>
        </header>
        <div class="cd-toolbar" role="toolbar" aria-label="${H(tr('Formatting'))}">
          ${tb('h1', 'Heading 1', 'H1')}${tb('h2', 'Heading 2', 'H2')}${tb('h3', 'Heading 3', 'H3')}${tb('p', 'Normal text', '¶')}
          <span class="cd-sep"></span>${tb('bold', 'Bold', '<b>B</b>')}${tb('italic', 'Italic', '<i>I</i>')}${tb('strike', 'Strikethrough', '<s>S</s>')}
          <span class="cd-sep"></span>${tb('ul', 'Bulleted list', '•≡')}${tb('ol', 'Numbered list', '1.')}${tb('quote', 'Quote', '❝')}
          <span class="cd-sep"></span>${tb('link', 'Link', '🔗')}${tb('table', 'Insert table', '▦')}
          <span class="cd-tbl-tools" hidden>${tb('row', 'Add row', '+▤')}${tb('col', 'Add column', '+▥')}${tb('delrow', 'Delete row', '−▤')}${tb('delcol', 'Delete column', '−▥')}${tb('deltable', 'Delete table', '✕▦')}</span>
          <span class="cd-sep"></span>${tb('undo', 'Undo', '↶')}${tb('redo', 'Redo', '↷')}
        </div>
        <div class="cd-notice" role="status" hidden></div>
        <div class="nb-jump-row"><label for="${this.id}-jump">Go to</label> <select id="${this.id}-jump" class="nb-jump-sel" data-nb-change="jump"></select></div>
        <div class="nb-body">
          <nav class="nb-outline" aria-label="${H(tr('Classes in this notebook'))}"><div class="nb-outline-h">Classes</div><ol class="nb-outline-list"></ol></nav>
          <div class="nb-page cd-print-area">
            <div class="nb-print-head"><b data-no-i18n>${H(tr('Notebook'))} · ${H(n.group_name || '')} · ${H(n.year_label || '')}</b></div>
            <div class="nb-empty" hidden></div>
            <div class="nb-sections"></div>
          </div>
        </div>
        <div class="cd-sheet" hidden></div>`;
    }
    updateEmpty() {
      const e = this.host.querySelector('.nb-empty'); if (!e) return;
      const none = !this.order.length; e.hidden = !none;
      if (none) e.innerHTML = `<p>${H(tr(this.isTeacher ? "No sections yet: each class gets its section when it starts. Add today's to start writing." : 'No sections yet: each class gets its section when it starts.'))}</p>`;
    }
    renderOutline() {
      const ol = this.host.querySelector('.nb-outline-list'); const sel = this.host.querySelector('.nb-jump-sel'); if (!ol) return;
      const today = this.info.today;
      ol.innerHTML = this.order.map(id => { const m = this.secs.get(id).meta; return `<li><button type="button" class="nb-ol-item${m.day === today ? ' today' : ''}${m.past ? ' past' : ''}" data-nb="jump" data-sec="${H(id)}"><span class="nb-ol-l" data-no-i18n>${H(secLabel(m, this.tz))}</span>${m.day === today ? ` <span class="nb-ol-today">${H(tr('Today'))}</span>` : ''}</button></li>`; }).join('');
      if (sel) sel.innerHTML = this.order.map(id => { const m = this.secs.get(id).meta; return `<option value="${H(id)}" data-no-i18n>${H(secLabel(m, this.tz))}${m.day === today ? ' · ' + H(tr('Today')) : ''}</option>`; }).join('');
      this.markOutline();
    }
    markOutline() {
      const id = this.active;
      this.host.querySelectorAll('.nb-ol-item').forEach(b => { const on = b.dataset.sec === id; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
      const sel = this.host.querySelector('.nb-jump-sel'); if (sel && id && sel.value !== id) sel.value = id;
    }
    jump(id, focus = true) {
      const s = id && this.secs.get(id); if (!s || !s.el) return;
      this.active = id; this.markOutline();
      const page = this.host.querySelector('.nb-page');
      if (page) page.scrollTop = Math.max(0, s.el.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - 6);
      s.el.classList.add('flash'); setTimeout(() => s.el?.classList.remove('flash'), 1600);
      if (focus && this.canEditSec(s)) { try { s.editor.commands.focus('end', { scrollIntoView: false }); } catch (e) { /* ignore */ } }
    }
    updateUi() {
      const root = this.host.querySelector('.nb-shell'); if (!root || !this.info) return;
      const i = this.info; const anyEdit = [...this.secs.values()].some(s => this.canEditSec(s)) || (this.participant && !i.locked);
      root.classList.toggle('readonly', !anyEdit);
      const lw = root.querySelector('.nb-lock-wrap'); const lb = root.querySelector('[data-nb="lock-menu"]');
      if (lw) lw.hidden = !this.isTeacher;
      if (lb) { lb.innerHTML = i.locked ? `🔒 <span>${H(tr('Locked for students'))}</span>` : i.lock_past ? `🗓 <span>${H(tr('Past classes locked'))}</span>` : `🔓 <span>${H(tr('Lock…'))}</span>`; lb.setAttribute('aria-pressed', String(!!(i.locked || i.lock_past))); }
      root.querySelectorAll('[data-nb="lock"]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === (i.locked ? 'all' : i.lock_past ? 'past' : 'none'))));
      ['today', 'paste'].forEach(k => { const b = root.querySelector(`[data-nb="${k}"]`); if (b) b.hidden = !this.isTeacher; });
      root.querySelector('.cd-toolbar').hidden = !anyEdit;
      const n = root.querySelector('.cd-notice');
      let msg = '', cls = '';
      if (inViewAs()) msg = tr('View as is read-only.');
      else if (i.role === 'admin') msg = tr('Read-only: institution admins can read the group notebook but not edit it.');
      else if (i.locked && i.role === 'student') { msg = tr('The teacher locked the notebook: you can read it but not edit it.'); cls = ' locked'; }
      else if (i.locked) { msg = tr('Locked for students: only you (and the substitute) can edit.'); cls = ' locked'; }
      else if (i.lock_past && i.role === 'student') { msg = tr("Past classes are locked: you can write in today's and upcoming classes."); cls = ' locked'; }
      else if (i.lock_past) { msg = tr('Past classes are locked for students.'); cls = ' locked'; }
      if (!msg && (Number(i.bytes) || 0) > 0.8 * MAX_BYTES) { msg = `${tr('The notebook is almost full')} (${fmtMB(i.bytes)} / 8 MB). ${tr('Delete content you no longer need, or export it and start a new section.')}`; cls = ' locked'; }
      if (this.status === 'full') { msg = tr('The notebook reached its maximum size (8 MB): delete content you no longer need to keep writing.'); cls = ' locked'; }
      if (n) { n.hidden = !msg; n.textContent = msg; n.className = 'cd-notice' + cls; }
      this.secs.forEach(s => { const e = this.canEditSec(s); if (s.editor && s.editor.isEditable !== e) s.editor.setEditable(e); if (s.el) this.renderSectionHead(s); });
      this.renderStatus(); this.renderPeople(); this.updateToolbar(); this.updateEmpty();
    }
    renderStatus() {
      const el = this.host.querySelector('.cd-status'); if (!el) return;
      const pend = [...this.secs.values()].some(s => s.pending.length);
      const canAny = this.participant && !(this.info.role === 'student' && this.info.locked);
      let cls = 'cd-status', txt;
      if (this.status === 'offline') { cls += ' err'; txt = tr('Connection problem: retrying…'); }
      else if (this.status === 'full') { cls += ' err'; txt = tr('Notebook full: not saved'); }
      else if (pend || this.pushing) { cls += ' saving'; txt = tr('Saving…'); }
      else if (this.rt) { cls += ' live'; txt = tr('● Live'); }
      else { cls += ' poll'; txt = tr('Live sync unavailable: updates every few seconds'); }
      if (!canAny && this.status !== 'offline') txt = (this.rt ? tr('● Live') : tr('Updates every few seconds')) + ' · ' + tr('Read-only');
      el.className = cls; el.textContent = txt;
      el.title = !pend && !this.pushing && canAny && this.status === 'ok' ? tr('All changes saved') : '';
    }
    renderPeople() {
      const el = this.host.querySelector('.cd-people'); if (!el) return;
      const seen = new Set(); const list = [];
      const me = this.participant && this.info.me ? [{ name: this.info.me.name, color: this.info.me.color, me: true }] : [];
      [...me, ...this.remote.values()].forEach(p => { const k = p.name + '|' + p.color; if (seen.has(k)) return; seen.add(k); list.push(p); });
      if (!list.length) { el.innerHTML = ''; return; }
      el.innerHTML = list.slice(0, 8).map(p => `<span class="cd-av" style="background:${safeColor(p.color)}" title="${H(p.name)}${p.me ? ' (' + H(tr('you')) + ')' : ''}" data-no-i18n>${H(initials(p.name))}</span>`).join('')
        + (list.length > 8 ? `<span class="cd-av more" data-no-i18n>+${list.length - 8}</span>` : '')
        + `<span class="cd-people-n"><b>${list.length}</b> <span>${H(tr(list.length === 1 ? 'person here' : 'people here'))}</span></span>`;
    }
    activeEditor() { const s = this.active && this.secs.get(this.active); return s && s.editor ? s : null; }
    updateToolbar() {
      const tb = this.host.querySelector('.cd-toolbar'); if (!tb || tb.hidden) return;
      const s = this.activeEditor(); const ed = s?.editor;
      const act = ed ? { h1: ed.isActive('heading', { level: 1 }), h2: ed.isActive('heading', { level: 2 }), h3: ed.isActive('heading', { level: 3 }), p: ed.isActive('paragraph'),
        bold: ed.isActive('bold'), italic: ed.isActive('italic'), strike: ed.isActive('strike'), ul: ed.isActive('bulletList'), ol: ed.isActive('orderedList'), quote: ed.isActive('blockquote'), link: ed.isActive('link') } : {};
      tb.querySelectorAll('[data-nb="fmt"]').forEach(b => { const on = !!act[b.dataset.k]; b.classList.toggle('on', on); if (b.dataset.k in act) b.setAttribute('aria-pressed', String(on)); b.disabled = !!s && !this.canEditSec(s); });
      const tt = tb.querySelector('.cd-tbl-tools'); if (tt) tt.hidden = !(ed && ed.isActive('table'));
    }

    // ── sync ──
    schedulePush() {
      this.renderStatus();
      clearTimeout(this.timers.push);
      const n = [...this.secs.values()].reduce((a, s) => a + s.pending.length, 0);
      this.timers.push = setTimeout(() => this.flush(), n > 30 ? 60 : 250);
    }
    async flush() {
      if (this.dead || this.pushing) return;
      const s = [...this.secs.values()].find(x => x.pending.length); if (!s) return;
      if (!this.canEditSec(s)) { s.pending = []; this.renderStatus(); if ([...this.secs.values()].some(x => x.pending.length)) this.schedulePush(); return; }
      if (this.status === 'full' && !this.capRetry) return;
      this.capRetry = false;
      const { Y } = this.M;
      const batch = s.pending; s.pending = []; this.pushing = true; this.renderStatus();
      const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
      const { data, error } = await rpc('notebook_push', { p_notebook: this.nb, p_section: s.meta.id, p_generation: this.gen, p_update: toB64(merged), p_client: String(this.cid) });
      this.pushing = false;
      if (this.dead) return;
      if (error) {
        const m = error.message || '';
        if (/bloqueó/i.test(m)) { toast(tr('The teacher locked the notebook: your last change was not saved.'), 'err', 5000); this.forceReload(); return; }
        if (/desactualizado/i.test(m)) { this.forceReload(); return; }
        if (/Solo lectura|No autorizado|Sección inválida/.test(m)) { s.pending = []; this.info.can_edit = false; this.updateUi(); return; }
        if (/tamaño máximo/.test(m)) { s.pending = batch.concat(s.pending); this.status = 'full'; this.updateUi(); if (!this.fullWarned) { this.fullWarned = true; toast(dbMsg(m), 'err', 9000); } this.snapshot(s, true); return; }
        s.pending = batch.concat(s.pending); this.status = 'offline'; this.renderStatus();
        clearTimeout(this.timers.push); this.timers.push = setTimeout(() => this.flush(), 3000); return;
      }
      if (this.status === 'offline' || this.status === 'loading' || this.status === 'full') { this.status = 'ok'; this.updateUi(); }
      s.sinceSnap++;
      this.poke('poke');
      this.renderStatus();
      if ([...this.secs.values()].some(x => x.pending.length)) this.schedulePush(); else this.maybeSnapshot();
      return data;
    }
    async forceReload() {
      const { data, error } = await rpc('notebook_open', { p_notebook: this.nb });
      if (this.dead || error || !data) return;
      this.rebuild(data);
    }
    schedulePull(ms) { clearTimeout(this.timers.pull); if (!this.dead) this.timers.pull = setTimeout(() => this.pull(), ms); }
    nextPollMs() { return document.hidden ? POLL_HIDDEN_MS : (this.rt ? POLL_RT_MS : POLL_MS); }
    async pull() {
      if (this.dead) return;
      if (this.pulling) { this.pullAgain = true; return; }
      this.pulling = true;
      const a = this.activeEditor();
      const cur = this.participant && a ? (a.aw.getLocalState()?.cursor ?? null) : null;
      const { data, error } = await rpc('notebook_pull', { p_notebook: this.nb, p_after: this.after, p_generation: this.gen, p_client: String(this.cid),
        p_presence: this.participant ? { s: a ? a.meta.id : null, cursor: cur } : null, p_known: this.known });
      this.pulling = false;
      if (this.dead) return;
      if (error || !data) {
        if (/No autorizado/.test(error?.message || '')) { this.destroy(true); this.fail(tr("You don't have access to this notebook.")); return; }
        this.status = 'offline'; this.renderStatus(); this.schedulePull(5000); return;
      }
      if (this.status === 'offline' || this.status === 'loading') this.status = 'ok';
      if ((data.generation || 1) !== this.gen) { const r = await rpc('notebook_open', { p_notebook: this.nb }); if (!this.dead && r.data) this.rebuild(r.data, 'restore'); }
      else {
        const lockChanged = !!data.locked !== !!this.info.locked || !!data.lock_past !== !!this.info.lock_past;
        const hadPending = [...this.secs.values()].some(s => s.pending.length);
        Object.assign(this.info, { locked: !!data.locked, lock_past: !!data.lock_past, can_edit: !!data.can_edit, today: data.today || this.info.today, bytes: data.bytes });
        if (Array.isArray(data.sections)) { this.known = data.count ?? data.sections.length; this.syncSections(data.sections); }
        const { Y } = this.M;
        (data.states || []).forEach(st => { const s = this.secs.get(st.s); if (s && st.d) Y.applyUpdate(s.ydoc, fromB64(st.d), REMOTE); this.after = Math.max(this.after, Number(st.upto) || 0); });
        (data.updates || []).forEach(u => this.applyUpdate(u, false));
        if (lockChanged) {
          if (hadPending && this.info.role === 'student') this.forceReload();
          this.updateUi();
          if (this.info.role === 'student') toast(tr(data.locked ? 'The teacher locked the notebook.' : data.lock_past ? 'The teacher locked the past classes of the notebook.' : 'The teacher unlocked the notebook: you can edit again.'), 'ok', 4000);
        } else if (Array.isArray(data.sections) || (Number(data.bytes) > 0.8 * MAX_BYTES) !== !!this.lastFullNotice) { this.lastFullNotice = Number(data.bytes) > 0.8 * MAX_BYTES; this.updateUi(); }
      }
      this.applyPresence(data.presence || []);
      this.renderStatus();
      if (this.pullAgain) { this.pullAgain = false; this.schedulePull(30); } else this.schedulePull(this.nextPollMs());
      this.maybeSnapshot();
    }
    maybeSnapshot() {
      if (this.pushing || this.snapping) return;
      const s = [...this.secs.values()].find(x => this.canEditSec(x) && !x.pending.length && (x.sinceSnap >= SNAP_EVERY || (x.dirty && Date.now() - x.lastSnap > SNAP_IDLE_MS && x.sinceSnap > 0)));
      if (s) this.snapshot(s);
    }
    async snapshot(s, force) {
      if (!this.canEditSec(s) || s.pending.length && !force || this.snapping) return;
      this.snapping = true;
      const state = toB64(this.M.Y.encodeStateAsUpdate(s.ydoc));
      const { data, error } = await rpc('notebook_snapshot', { p_notebook: this.nb, p_section: s.meta.id, p_generation: this.gen, p_state: state, p_upto: this.after });
      this.snapping = false;
      if (!error && data) { s.sinceSnap = 0; s.lastSnap = Date.now(); s.dirty = false; if (force && data.ok && this.status === 'full') { this.capRetry = true; this.status = 'ok'; this.updateUi(); this.schedulePush(); } }
      else if (error && /tamaño máximo/.test(error.message || '') && !this.fullWarned) { this.fullWarned = true; toast(dbMsg(error.message), 'err', 9000); }
    }

    // ── presence + cursors (one awareness per section; names and colours from the database) ──
    applyPresence(list) {
      const now = Date.now(); const keep = new Set();
      const touched = new Map(); // section id → {added, updated, removed}
      const ch = id => { if (!touched.has(id)) touched.set(id, { added: [], updated: [], removed: [] }); return touched.get(id); };
      list.forEach(p => {
        const id = Number(p.client); if (!Number.isFinite(id) || id === this.cid) return;
        keep.add(id);
        const live = this.rtCursors.get(id);
        const rec = { name: String(p.name || ''), color: safeColor(p.color), role: p.role, s: live ? live.s : (p.state?.s ?? null), cursor: live ? live.cur : (p.state?.cursor ?? null) };
        this.remote.set(id, rec);
        this.placeCursor(id, rec, ch, now);
      });
      [...this.remote.keys()].forEach(id => { if (!keep.has(id)) { this.remote.delete(id); this.rtCursors.delete(id); this.secs.forEach((s, sid) => { if (s.aw.states.has(id)) { s.aw.states.delete(id); s.aw.meta.delete(id); ch(sid).removed.push(id); } }); } });
      touched.forEach((c, sid) => { const s = this.secs.get(sid); if (s && (c.added.length || c.updated.length || c.removed.length)) s.aw.emit('change', [c, REMOTE]); });
      this.renderPeople();
    }
    placeCursor(id, rec, ch, now) {
      this.secs.forEach((s, sid) => {
        const here = rec.s === sid;
        if (here) {
          const had = s.aw.states.has(id);
          s.aw.states.set(id, { user: { name: rec.name, color: rec.color }, cursor: rec.cursor });
          s.aw.meta.set(id, { clock: (s.aw.meta.get(id)?.clock || 0) + 1, lastUpdated: now });
          (had ? ch(sid).updated : ch(sid).added).push(id);
        } else if (s.aw.states.has(id)) { s.aw.states.delete(id); s.aw.meta.delete(id); ch(sid).removed.push(id); }
      });
    }
    remoteCursor(msg) {
      const id = Number(msg?.c); if (!Number.isFinite(id) || id === this.cid) return;
      const cur = msg.cur && typeof msg.cur === 'object' ? msg.cur : null; const sec = typeof msg.s === 'string' ? msg.s : null;
      this.rtCursors.set(id, { s: sec, cur });
      const rec = this.remote.get(id);
      if (!rec) { this.schedulePull(80); return; } // a new person: their name comes from the database
      rec.s = sec; rec.cursor = cur;
      const touched = new Map(); const ch = k => { if (!touched.has(k)) touched.set(k, { added: [], updated: [], removed: [] }); return touched.get(k); };
      this.placeCursor(id, rec, ch, Date.now());
      touched.forEach((c, sid) => this.secs.get(sid)?.aw.emit('change', [c, REMOTE]));
    }
    localCursorChanged(s) {
      if (!this.participant || !this.channel || !this.rt) return;
      clearTimeout(this.timers.cur);
      this.timers.cur = setTimeout(() => { const cur = s.aw.getLocalState()?.cursor ?? null; if (cur || this.active === s.meta.id) this.send('cur', { c: String(this.cid), s: s.meta.id, cur }); }, 120);
    }

    // ── Realtime: private channel → public fallback (unguessable name) → polling ──
    connectRealtime() {
      if (typeof sb === 'undefined' || typeof sb.channel !== 'function') return;
      const tryJoin = (topic, priv) => new Promise(resolve => {
        let done = false; const ch = sb.channel(topic, { config: { private: priv, broadcast: { self: false, ack: false } } });
        ch.on('broadcast', { event: 'poke' }, () => this.schedulePull(40));
        ch.on('broadcast', { event: 'lock' }, () => this.schedulePull(20));
        ch.on('broadcast', { event: 'hello' }, () => this.schedulePull(60));
        ch.on('broadcast', { event: 'cur' }, m => this.remoteCursor(m?.payload));
        const t = setTimeout(() => { if (!done) { done = true; try { sb.removeChannel(ch); } catch (e) { /* ignore */ } resolve(null); } }, 8000);
        ch.subscribe(status => {
          if (this.dead) { if (!done) { done = true; clearTimeout(t); try { sb.removeChannel(ch); } catch (e) { /* ignore */ } resolve(null); } return; }
          if (status === 'SUBSCRIBED') { if (!done) { done = true; clearTimeout(t); resolve(ch); } else if (this.channel === ch) { this.rt = this.rtKind; this.renderStatus(); } }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (!done) { done = true; clearTimeout(t); try { sb.removeChannel(ch); } catch (e) { /* ignore */ } resolve(null); }
            else if (this.channel === ch) { this.rt = null; this.renderStatus(); this.schedulePull(POLL_MS); }
          }
        });
      });
      (async () => {
        const topic = this.info.channel?.topic; const key = this.info.channel?.key;
        let ch = topic ? await tryJoin(topic, true) : null; let kind = 'private';
        if (!ch && key && !this.dead) { ch = await tryJoin('notebook-' + key, false); kind = 'public'; }
        if (this.dead) { if (ch) try { sb.removeChannel(ch); } catch (e) { /* ignore */ } return; }
        this.channel = ch; this.rtKind = ch ? kind : null; this.rt = this.rtKind;
        this.renderStatus();
        if (ch) { this.send('hello', {}); this.schedulePull(80); }
      })();
    }
    send(event, payload) {
      if (!this.channel || !this.rt || !this.participant) return;
      if (this.info.role === 'student' && this.info.locked && event !== 'hello') return; // the policy refuses it anyway
      try { this.channel.send({ type: 'broadcast', event, payload }); } catch (e) { /* the next pull covers it */ }
    }
    poke(kind) { this.send(kind, { g: this.gen }); }

    // ── actions ──
    click(e) {
      const el = e.target.closest('[data-nb]');
      if (!el || !this.host.contains(el)) {
        this.host.querySelectorAll('.cd-menu').forEach(m => { if (!m.hidden && !e.target.closest('.cd-menu-wrap')) this.toggleMenu(m, false); });
        return;
      }
      const a = el.dataset.nb;
      if (a !== 'export-menu' && a !== 'lock-menu') this.host.querySelectorAll('.cd-menu').forEach(m => this.toggleMenu(m, false));
      switch (a) {
        case 'fmt': this.fmt(el.dataset.k); break;
        case 'jump': this.jump(el.dataset.sec); break;
        case 'lock-menu': this.toggleMenu(this.host.querySelector('.nb-lock-menu')); break;
        case 'lock': this.setLock(el.dataset.mode, el); break;
        case 'today': this.addToday(el); break;
        case 'paste': this.pasteDialog(); break;
        case 'paste-pick': this.pasteClass(el.dataset.id, el); break;
        case 'legacy': if (window.TCClassDoc) window.TCClassDoc.open(el.dataset.session); break;
        case 'import': this.importLegacy(el.dataset.sec, el); break;
        case 'notes-toggle': { const box = el.closest('.nb-notes'); box?.classList.toggle('open'); el.setAttribute('aria-expanded', String(!!box?.classList.contains('open'))); break; }
        case 'note-del': this.deleteNote(el.dataset.id, el); break;
        case 'history': this.historyDialog(); break;
        case 'ver-open': this.previewVersion(el.dataset.id); break;
        case 'ver-restore': this.restoreVersion(el.dataset.id, el); break;
        case 'ver-save': this.saveVersion(el); break;
        case 'sheet-close': this.closeSheet(); break;
        case 'export-menu': this.toggleMenu(this.host.querySelector('.nb-export-menu')); break;
        case 'print': this.print(el.dataset.scope); break;
        case 'dl-html': this.downloadHtml(el.dataset.scope); break;
        case 'dl-md': this.downloadMd(el.dataset.scope); break;
        case 'close': if (this.opts.onClose) this.opts.onClose(); break;
      }
    }
    change(e) {
      const k = e.target?.dataset?.nbChange; if (!k) return;
      if (k === 'jump') this.jump(e.target.value);
      if (k === 'year') { const y = Number(e.target.value); const g = this.info?.notebook?.group_id; if (g && y) { if (this.opts.onClose && overlay === this) open({ group: g, year: y }); else if (this.opts.onYear) this.opts.onYear(y); } }
    }
    toggleMenu(m, force) {
      if (!m) return; const b = m.parentElement?.querySelector('[aria-haspopup]');
      const want = force === undefined ? m.hidden : !!force; m.hidden = !want; if (b) b.setAttribute('aria-expanded', String(want));
    }
    fmt(k) {
      const s = this.activeEditor(); if (!s || !this.canEditSec(s)) return; const ed = s.editor;
      const c = ed.chain().focus();
      switch (k) {
        case 'h1': c.toggleHeading({ level: 1 }).run(); break;
        case 'h2': c.toggleHeading({ level: 2 }).run(); break;
        case 'h3': c.toggleHeading({ level: 3 }).run(); break;
        case 'p': c.setParagraph().run(); break;
        case 'bold': c.toggleBold().run(); break;
        case 'italic': c.toggleItalic().run(); break;
        case 'strike': c.toggleStrike().run(); break;
        case 'ul': c.toggleBulletList().run(); break;
        case 'ol': c.toggleOrderedList().run(); break;
        case 'quote': c.toggleBlockquote().run(); break;
        case 'table': c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
        case 'row': c.addRowAfter().run(); break;
        case 'col': c.addColumnAfter().run(); break;
        case 'delrow': c.deleteRow().run(); break;
        case 'delcol': c.deleteColumn().run(); break;
        case 'deltable': c.deleteTable().run(); break;
        case 'undo': c.undo().run(); break;
        case 'redo': c.redo().run(); break;
        case 'link': {
          const prev = ed.getAttributes('link').href || '';
          const url = window.prompt(tr('Link address (https://…). Leave it empty to remove the link.'), prev);
          if (url === null) break;
          const u = url.trim();
          if (!u) { ed.chain().focus().extendMarkRange('link').unsetLink().run(); break; }
          const href = /^(https?:\/\/|mailto:)/i.test(u) ? u : 'https://' + u;
          if (!/^(https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+)$/i.test(href)) { toast(tr('Invalid link.'), 'err'); break; }
          if (ed.state.selection.empty) ed.chain().focus().insertContent([{ type: 'text', text: u, marks: [{ type: 'link', attrs: { href } }] }]).run();
          else ed.chain().focus().extendMarkRange('link').setLink({ href }).run();
          break;
        }
      }
    }
    async setLock(mode, btn) {
      if (!this.isTeacher || (typeof vaBlocked === 'function' && vaBlocked())) return;
      btn.disabled = true;
      const { data, error } = await rpc('notebook_set_lock', { p_notebook: this.nb, p_locked: mode === 'all', p_lock_past: mode === 'past' });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      this.info.locked = !!data?.locked; this.info.lock_past = !!data?.lock_past; this.updateUi(); this.poke('lock');
      toast(tr(this.info.locked ? 'Locked: students can read but not edit.' : this.info.lock_past ? 'Past classes locked: students write only in today\'s and upcoming classes.' : 'Unlocked: students can edit again.'), 'ok');
    }
    async addToday(btn) {
      if (!this.isTeacher || (typeof vaBlocked === 'function' && vaBlocked())) return;
      btn.disabled = true;
      const { data, error } = await rpc('notebook_add_section', { p_notebook: this.nb, p_title: null, p_session: null, p_today: true });
      btn.disabled = false;
      if (error) { toast('Error: ' + dbMsg(error.message), 'err'); return; }
      await this.refreshSections();
      this.poke('poke');
      if (data?.section_id) this.jump(data.section_id);
      toast(tr(data?.created ? "Today's section added ✓" : "Today's section was already there."), 'ok');
    }
    async refreshSections() { this.known = -1; await this.pull(); }
    // where an insertion goes: the section with the cursor, else the "current" one (today's / the one in view)
    targetSection() { const s = this.activeEditor(); if (s && this.canEditSec(s)) return s; const d = this.secs.get(this.defaultSection() || ''); return d && this.canEditSec(d) ? d : null; }
    insertHtml(s, html) {
      const ed = s.editor; if (!ed) return false;
      if (ed.isFocused || this.active === s.meta.id && ed.state.selection && !ed.isEmpty) ed.chain().focus().insertContent(html).run();
      else if (ed.isEmpty) ed.chain().setContent(html).focus('end').run();
      else ed.chain().insertContentAt(ed.state.doc.content.size, html).focus('end').run();
      return true;
    }

    // ── paste a saved class (student handout only) into the current section ──
    async pasteDialog() {
      if (!this.isTeacher) return;
      if ((typeof plannings === 'undefined' || !plannings.length) && typeof loadPlannings === 'function') { try { await loadPlannings(); } catch (e) { /* ignore */ } }
      const list = (typeof plannings !== 'undefined' && Array.isArray(plannings)) ? plannings.slice() : [];
      const t = this.targetSection();
      const rows = list.map(p => {
        const ok = !!String(p.student || '').trim();
        return `<li class="cd-pick${ok ? '' : ' off'}"><div class="cd-pick-main"><b data-no-i18n>${H(p.title || '—')}</b><span class="cd-pick-meta" data-no-i18n>${H(p.date ? fDT(p.date) : '')}</span>
          ${ok ? '' : `<span class="cd-pick-note">${H(tr('No student handout yet: open it in Classes and the handout is prepared there.'))}</span>`}</div>
          <button type="button" class="tree-btn${ok ? ' primary' : ''}" data-nb="paste-pick" data-id="${H(p.id)}"${ok && t ? '' : ' disabled'}>${H(tr('Insert'))}</button></li>`;
      }).join('');
      this.sheet(`<div class="cd-sheet-h"><b>🎒 <span>Paste a class</span></b><button type="button" class="cd-x" data-nb="sheet-close" aria-label="${H(tr('Close'))}">✕</button></div>
        <p class="cd-sheet-sub"><span>We insert the</span> <b>student handout</b> <span>of the class (without answers or teacher notes) into the section:</span> <b data-no-i18n>${t ? H(secLabel(t.meta, this.tz)) : '—'}</b>. <span>The teacher guide is never shared here.</span></p>
        ${t ? '' : `<div class="cd-empty">${H(tr("Add today's section first."))}</div>`}
        ${rows ? `<ul class="cd-pick-list">${rows}</ul>` : `<div class="cd-empty">${H(tr("You don't have saved classes yet. Create one in Classes and save it."))}</div>`}`);
      this.pasteTarget = t ? t.meta.id : null;
    }
    pasteClass(id, btn) {
      const s = this.secs.get(this.pasteTarget || ''); if (!this.isTeacher || !s || !this.canEditSec(s)) return;
      const p = (typeof plannings !== 'undefined' ? plannings : []).find(x => String(x.id) === String(id));
      if (!p || !String(p.student || '').trim()) return;
      const text = typeof cleanStudentHandout === 'function' ? cleanStudentHandout(p.student) : p.student; // never the teacher guide or answers
      if (btn) btn.disabled = true;
      this.insertHtml(s, handoutToHtml(text, ''));
      this.closeSheet(); this.jump(s.meta.id, false);
      toast(tr('Student handout inserted ✓'), 'ok');
    }
    // ── the previous (per-class) document of a section → into the section (teacher) ──
    async importLegacy(secId, btn) {
      const s = this.secs.get(secId); if (!this.isTeacher || !s || !s.meta.session_id) return;
      if (!btn.classList.contains('confirm')) { btn.classList.add('confirm'); btn.innerHTML = `<span>${H(tr('Click again to add it at the end of this section'))}</span>`; setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.innerHTML = `⤵ <span>${H(tr('Import the previous document into this section'))}</span>`; } }, 4000); return; }
      btn.disabled = true;
      const { data, error } = await rpc('classdoc_open', { p_session: s.meta.session_id });
      btn.disabled = false;
      if (error || !data) { toast('Error: ' + (error?.message || ''), 'err'); return; }
      const { Y } = this.M; const d = new Y.Doc();
      try { if (data.state) Y.applyUpdate(d, fromB64(data.state)); (data.updates || []).forEach(u => Y.applyUpdate(d, fromB64(u.d))); } catch (e) { /* keep what was read */ }
      const json = this.M.yXmlFragmentToProsemirrorJSON(d.getXmlFragment('default')); d.destroy();
      const content = (json && json.content) || [];
      if (!content.length) { toast(tr('The previous document is empty.'), 'err'); return; }
      const ed = s.editor; if (ed.isEmpty) ed.chain().setContent({ type: 'doc', content }).run(); else ed.chain().insertContentAt(ed.state.doc.content.size, content).run();
      btn.classList.remove('confirm'); btn.innerHTML = `⤵ <span>${H(tr('Import the previous document into this section'))}</span>`;
      this.jump(secId, false);
      toast(tr('Previous document imported into this section ✓ (the original is kept).'), 'ok', 5000);
    }
    // ── teacher-only notes (the teacher guide sent from the generator): never shown to students ──
    async loadNotes() { const { data } = await rpc('notebook_notes', { p_notebook: this.nb }); if (this.dead) return; this.notes = Array.isArray(data) ? data : []; this.renderNotes(); }
    renderNotes() {
      if (!this.isTeacher || !Array.isArray(this.notes)) return;
      this.secs.forEach((s, sid) => {
        const box = s.el?.querySelector('.nb-notes'); if (!box) return;
        const mine = this.notes.filter(n => n.section_id === sid);
        box.hidden = !mine.length;
        if (!mine.length) { box.innerHTML = ''; return; }
        const open = box.classList.contains('open');
        box.innerHTML = `<button type="button" class="nb-notes-h" data-nb="notes-toggle" aria-expanded="${open}">🔒 <span>Teacher notes</span> <span class="nb-notes-n">(${mine.length})</span> · <span class="nb-notes-hint">Only you and the substitute see them.</span></button>
          <div class="nb-notes-body">${mine.map(n => `<article class="nb-note"><div class="nb-note-h"><b data-no-i18n>${H(n.title || tr('Teacher guide'))}</b><span class="cd-pick-meta" data-no-i18n>${H(fDT(n.created_at))}${n.by ? ' · ' + H(n.by) : ''}</span>
            <button type="button" class="cd-x" data-nb="note-del" data-id="${H(n.id)}" title="${H(tr('Delete note'))}" aria-label="${H(tr('Delete note'))}">🗑</button></div>
            <div class="nb-note-body cls-doc" data-no-i18n>${typeof formatDoc === 'function' ? formatDoc(n.body) : H(n.body)}</div></article>`).join('')}</div>`;
      });
    }
    async deleteNote(id, btn) {
      if (!this.isTeacher || (typeof vaBlocked === 'function' && vaBlocked())) return;
      if (!btn.classList.contains('confirm')) { btn.classList.add('confirm'); btn.textContent = tr('Delete?'); setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.textContent = '🗑'; } }, 4000); return; }
      const { error } = await rpc('notebook_delete_note', { p_note: id });
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      this.notes = (this.notes || []).filter(n => n.id !== id); this.renderNotes();
    }

    sheet(html) {
      const s = this.host.querySelector('.cd-sheet'); if (!s) return null;
      s.innerHTML = `<div class="cd-sheet-box" role="dialog" aria-modal="true">${html}</div>`; s.hidden = false;
      setTimeout(() => s.querySelector('button,input,select')?.focus(), 30);
      return s;
    }
    closeSheet() { const s = this.host.querySelector('.cd-sheet'); if (s) { s.hidden = true; s.innerHTML = ''; } (this.previews || []).forEach(p => { try { p.destroy(); } catch (e) { /* ignore */ } }); this.previews = []; }

    // ── history: versions of the whole notebook, preview, restore (teacher) ──
    async historyDialog() {
      const head = `<div class="cd-sheet-h"><b>🕘 <span>History</span></b><button type="button" class="cd-x" data-nb="sheet-close" aria-label="${H(tr('Close'))}">✕</button></div>`;
      const s = this.sheet(head + `<div class="cd-loading">${H(tr('Loading…'))}</div>`);
      const { data, error } = await rpc('notebook_versions', { p_notebook: this.nb });
      if (!s || s.hidden) return;
      const box = s.querySelector('.cd-sheet-box');
      if (error) { box.querySelector('.cd-loading').textContent = tr('Could not load the history.'); return; }
      const L = { auto: 'Automatic', class_end: 'End of class', manual: 'Saved by the teacher', before_restore: 'Before a restore' };
      const items = (data || []).map(v => `<li class="cd-ver"><button type="button" class="cd-ver-open" data-nb="ver-open" data-id="${H(v.id)}"><b>${H(tr(L[v.label] || v.label))}</b>
        <span class="cd-pick-meta" data-no-i18n>${H(fDT(v.created_at))}${v.by ? ' · ' + H(v.by) : ''}</span></button></li>`).join('');
      box.innerHTML = head + `<p class="cd-sheet-sub">${H(tr(this.isTeacher ? 'Versions of the whole notebook are saved every 10 minutes while people write, at the end of each class and when you save one. Open one to see it; you can restore it.' : 'Versions of the whole notebook are saved every 10 minutes while people write and at the end of each class. Only the teacher can restore one.'))}</p>
        ${this.isTeacher ? `<div class="gc-btn-row"><button type="button" class="tree-btn" data-nb="ver-save">💾 <span>Save a version now</span></button></div>` : ''}
        ${items ? `<ul class="cd-ver-list">${items}</ul>` : `<div class="cd-empty">${H(tr('No versions yet.'))}</div>`}
        <div class="cd-preview-wrap" hidden><div class="cd-preview-h"><b class="cd-preview-title" data-no-i18n></b> ${this.isTeacher ? `<button type="button" class="tree-btn danger" data-nb="ver-restore">↩ <span>Restore this version</span></button>` : ''}</div><div class="cd-preview nb-preview" data-no-i18n></div></div>`;
    }
    async previewVersion(id) {
      const s = this.host.querySelector('.cd-sheet'); if (!s) return;
      const { data, error } = await rpc('notebook_version', { p_version: id });
      if (error || !data) { toast('Error: ' + (error?.message || ''), 'err'); return; }
      const M = this.M; const wrap = s.querySelector('.cd-preview-wrap'); const pv = s.querySelector('.nb-preview'); if (!wrap || !pv) return;
      (this.previews || []).forEach(p => { try { p.destroy(); } catch (e) { /* ignore */ } }); this.previews = [];
      pv.innerHTML = '';
      const parts = new Map((data.sections || []).map(x => [x.s, x.parts || []]));
      const ids = [...this.order.filter(x => parts.has(x)), ...[...parts.keys()].filter(x => !this.order.includes(x))];
      ids.forEach(sid => {
        const doc = new M.Y.Doc(); (parts.get(sid) || []).forEach(p => { try { M.Y.applyUpdate(doc, fromB64(p)); } catch (e) { /* ignore */ } });
        const meta = this.secs.get(sid)?.meta; const block = document.createElement('div'); block.className = 'nb-pv-sec';
        block.innerHTML = `<div class="nb-pv-h">${H(meta ? secLabel(meta, this.tz) : tr('Section'))}</div><div class="nb-pv-ed"></div>`;
        pv.appendChild(block);
        this.previews.push(new M.Editor({ element: block.querySelector('.nb-pv-ed'), editable: false, extensions: [...EXT(M), M.Collaboration.configure({ document: doc })] }));
      });
      const L = { auto: 'Automatic', class_end: 'End of class', manual: 'Saved by the teacher', before_restore: 'Before a restore' };
      wrap.querySelector('.cd-preview-title').textContent = `${tr(L[data.label] || data.label)} · ${fDT(data.created_at)}`;
      const rb = wrap.querySelector('[data-nb="ver-restore"]'); if (rb) rb.dataset.id = id;
      wrap.hidden = false; s.querySelectorAll('.cd-ver-open').forEach(b => b.classList.toggle('on', b.dataset.id === id));
      wrap.scrollIntoView({ block: 'nearest' });
    }
    async restoreVersion(id, btn) {
      if (!this.isTeacher || !id || (typeof vaBlocked === 'function' && vaBlocked())) return;
      if (!btn.classList.contains('confirm')) { btn.classList.add('confirm'); btn.innerHTML = `<span>${H(tr('Click again: everyone sees this version'))}</span>`; setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.innerHTML = `↩ <span>${H(tr('Restore this version'))}</span>`; } }, 4000); return; }
      btn.disabled = true;
      await this.flushAll();
      const { error } = await rpc('notebook_restore', { p_version: id });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      this.closeSheet(); this.poke('poke');
      const { data } = await rpc('notebook_open', { p_notebook: this.nb });
      if (data && !this.dead) { this.rebuild(data); toast(tr('Version restored ✓'), 'ok'); this.poke('poke'); }
    }
    async saveVersion(btn) {
      if (!this.isTeacher) return;
      btn.disabled = true; await this.flushAll();
      const { data, error } = await rpc('notebook_add_version', { p_notebook: this.nb, p_label: 'manual' });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      toast(tr(data?.created ? 'Version saved ✓' : 'The notebook is empty: nothing to save yet.'), data?.created ? 'ok' : 'err');
      if (data?.created) this.historyDialog();
    }
    async flushAll() { for (let i = 0; i < 20 && !this.dead && [...this.secs.values()].some(s => s.pending.length && this.canEditSec(s)); i++) { if (this.pushing) await new Promise(r => setTimeout(r, 80)); else await this.flush(); } }

    // ── export: the whole notebook or the current section ──
    scopeSecs(scope) { if (scope === 'one') { const s = this.secs.get(this.active || this.defaultSection() || ''); return s ? [s] : []; } return this.order.map(id => this.secs.get(id)); }
    print(scope) {
      const one = scope === 'one' ? this.scopeSecs('one')[0] : null;
      document.body.classList.add('nb-printing'); this.host.classList.add('nb-print-root');
      if (one) { this.host.classList.add('nb-print-one'); one.el.classList.add('nb-print-this'); }
      const done = () => { document.body.classList.remove('nb-printing'); this.host.classList.remove('nb-print-root', 'nb-print-one'); this.host.querySelectorAll('.nb-print-this').forEach(x => x.classList.remove('nb-print-this')); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      try { window.print(); } finally { setTimeout(done, 1500); }
    }
    fileBase(scope) { const n = this.info.notebook || {}; const one = scope === 'one' ? this.scopeSecs('one')[0] : null; return [tr('notebook'), slug(n.group_name), n.year, one ? (one.meta.number ? tr('class') + '-' + one.meta.number : slug(one.meta.title || 'section')) : ''].filter(Boolean).join('-'); }
    htmlDoc(scope) {
      const n = this.info.notebook || {}; const list = this.scopeSecs(scope);
      const title = `${tr('Notebook')} · ${n.group_name || ''} · ${n.year_label || ''}`;
      return `<!DOCTYPE html><html lang="${lang()}"><head><meta charset="UTF-8"><title>${H(title)}</title>
<style>body{font-family:Inter,Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1a1a1a;line-height:1.65}h1,h2,h3{line-height:1.3}section{border-top:2px solid #ece4ff;margin-top:22px;padding-top:6px}.sec-h{color:#5b3fa0;font-size:20px}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccc;padding:6px 8px;vertical-align:top}th{background:#f3eeff}blockquote{border-left:3px solid #d4c5f0;margin:8px 0;padding:2px 12px;color:#444}.meta{color:#888;font-size:13px;border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:16px}</style></head>
<body><h1>${H(title)}</h1><div class="meta">${H(tr('Group notebook'))} · TeroClass</div>
${list.map(s => `<section><h2 class="sec-h">${H(secLabel(s.meta, this.tz))}</h2>${s.meta.kind === 'session' && s.meta.title ? `<div class="meta">${H(s.meta.title)}</div>` : ''}${s.editor ? s.editor.getHTML() : ''}</section>`).join('\n')}</body></html>`;
    }
    downloadHtml(scope) { download(this.fileBase(scope) + '.html', this.htmlDoc(scope), 'text/html;charset=utf-8'); }
    downloadMd(scope) {
      const n = this.info.notebook || {};
      const md = `# ${tr('Notebook')} · ${n.group_name || ''} · ${n.year_label || ''}\n\n` + this.scopeSecs(scope).map(s => `## ${secLabel(s.meta, this.tz)}\n\n${s.meta.kind === 'session' && s.meta.title ? '_' + s.meta.title + '_\n\n' : ''}${s.editor ? toMarkdown(s.editor.getJSON()) : ''}`).join('\n');
      download(this.fileBase(scope) + '.md', md, 'text/markdown;charset=utf-8');
    }

    async close() { try { await Promise.race([this.flushAll(), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* ignore */ } this.destroy(); }
    destroy(keepDom) {
      if (this.dead) return; this.dead = true;
      Object.values(this.timers).forEach(t => clearTimeout(t));
      document.removeEventListener('visibilitychange', this.onVis);
      this.host.removeEventListener('click', this.onClick);
      this.host.removeEventListener('change', this.onChange);
      this.host.removeEventListener('mousedown', this.onDown);
      if (this.channel) { try { sb.removeChannel(this.channel); } catch (e) { /* ignore */ } this.channel = null; }
      (this.previews || []).forEach(p => { try { p.destroy(); } catch (e) { /* ignore */ } });
      this.destroySections();
      if (!keepDom) this.host.innerHTML = '';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Entry points
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // {group?, session?, year?} → {notebook_id, section_id, adhoc, …} (View as: never creates anything)
  async function resolve(target) {
    const { data, error } = await rpc(inViewAs() ? 'notebook_find' : 'notebook_resolve', { p_group: target.group || null, p_session: target.session || null, p_year: target.year || null });
    if (error) throw error;
    return data || {};
  }
  let overlay = null;
  function overlayEl() {
    let el = document.getElementById('nb-overlay');
    if (!el) { el = document.createElement('div'); el.id = 'nb-overlay'; el.className = 'cd-overlay nb-overlay'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', tr('Group notebook')); document.body.appendChild(el); }
    return el;
  }
  // open({group}|{session}|{notebook, section}) — a class without a group opens its own class document instead
  async function open(target = {}) {
    if (overlay) await closeOverlay();
    let nb = target.notebook || null; let section = target.section || null;
    if (!nb) {
      let r;
      try { r = await resolve(target); } catch (e) { toast(/No autorizado/.test(e?.message || '') ? tr("You don't have access to this notebook.") : 'Error: ' + (e?.message || ''), 'err'); return null; }
      if (r.adhoc) return window.TCClassDoc ? window.TCClassDoc.open(target.session) : null;
      if (!r.notebook_id) { toast(tr(r.role === 'admin' ? 'This group has no notebook for this school year yet: it is created when the teacher or a student opens it.' : 'Could not open the notebook.'), 'err', 6000); return null; }
      nb = r.notebook_id; section = section || r.section_id || null;
    }
    const el = overlayEl();
    el.innerHTML = '<div class="cd-overlay-box nb-box"></div>'; el.classList.add('active'); document.body.classList.add('cd-open');
    const view = new NotebookView(el.firstChild, nb, { section, onClose: () => closeOverlay() });
    overlay = view;
    await view.init();
    return view;
  }
  async function closeOverlay() {
    const v = overlay; overlay = null; if (v) await v.close();
    const el = document.getElementById('nb-overlay'); if (el) { el.classList.remove('active'); el.innerHTML = ''; }
    if (!document.querySelector('#cd-overlay.active, #cb-overlay.active')) document.body.classList.remove('cd-open');
  }
  // live-class side panel: the group notebook on this class's section; a one-off class keeps its class document
  async function mount(host, sessionId, opts = {}) {
    let r = null;
    try { r = await resolve({ session: sessionId }); } catch (e) { r = null; }
    if (!r || r.adhoc || !r.notebook_id) {
      if (r && !r.adhoc && !r.notebook_id) { host.innerHTML = `<div class="cd-shell compact"><div class="cd-fail"><span aria-hidden="true">📒</span><p>${H(tr('This group has no notebook for this school year yet.'))}</p></div></div>`; return null; }
      return window.TCClassDoc ? window.TCClassDoc.mount(host, sessionId, opts) : null;
    }
    const v = new NotebookView(host, r.notebook_id, { ...opts, compact: true, section: r.section_id });
    host.__nbView = v; await v.init(); return v;
  }
  // a class starts (live room): its section exists from now on, even if nobody opens the notebook
  function ensureSession(sessionId) { if (!sessionId || inViewAs()) return; rpc('notebook_resolve', { p_session: sessionId }).then(() => {}, () => {}); }
  // a class ends (teacher in the live room): "end of class" version of the group notebook
  async function classEnd(sessionId) {
    if (!sessionId || inViewAs()) return;
    try { const r = await resolve({ session: sessionId }); if (r.notebook_id && r.role === 'teacher') await rpc('notebook_add_version', { p_notebook: r.notebook_id, p_label: 'class_end' }); } catch (e) { /* nothing to save */ }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // "Send to the group notebook" from the generator (a generated class or a saved one)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const SEND = { targets: null, el: null };
  function onDocShown() {
    const bar = document.querySelector('#ai-output .cls-doc-actions'); if (!bar || bar.querySelector('#btn-send-notebook')) return;
    if (typeof currentUser !== 'undefined' && currentUser && currentUser.isStudent) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-out'; b.id = 'btn-send-notebook'; b.dataset.nbSend = 'open';
    b.innerHTML = '📒 <span>Send to the group notebook</span>';
    bar.appendChild(b);
  }
  // the text of a generator document as the teacher sees it (edits included), one line per formatted line (formatDoc renders one
  // block per line; innerText is not used because the tab that is not shown has no line breaks)
  const docLines = el => (el ? [...el.children].map(c => c.textContent || '').join('\n') : '');
  const handoutText = () => {
    const r = typeof currentResult !== 'undefined' ? currentResult : null; if (!r) return '';
    const el = document.getElementById('lp-doc-student');
    const raw = el && el.getAttribute('contenteditable') === 'true' && r.student ? docLines(el) : (r.student || '');
    return typeof cleanStudentHandout === 'function' ? cleanStudentHandout(raw) : raw; // answers / teacher lines removed again
  };
  const guideText = () => { const r = typeof currentResult !== 'undefined' ? currentResult : null; const el = document.getElementById('lp-doc'); return (docLines(el) || r?.text || '').trim(); };
  function sendBox(html) {
    let el = document.getElementById('nb-send');
    if (!el) { el = document.createElement('div'); el.id = 'nb-send'; el.className = 'cd-overlay nb-send'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'nb-send-h'); document.body.appendChild(el); }
    el.innerHTML = `<div class="cd-sheet-box nb-send-box">${html}</div>`; el.classList.add('active');
    SEND.el = el; setTimeout(() => el.querySelector('select,input,button')?.focus(), 30);
    return el;
  }
  function closeSend() { const el = document.getElementById('nb-send'); if (el) { el.classList.remove('active'); el.innerHTML = ''; } }
  async function sendDialog() {
    if (typeof currentResult === 'undefined' || !currentResult) { toast(tr('Generate a lesson plan first.'), 'err'); return; }
    if (typeof vaBlocked === 'function' && vaBlocked()) return;
    sendBox(`<div class="cd-sheet-h"><b id="nb-send-h">📒 <span>Send to the group notebook</span></b><button type="button" class="cd-x" data-nb-send="close" aria-label="${H(tr('Close'))}">✕</button></div><div class="cd-loading">${H(tr('Loading…'))}</div>`);
    const { data, error } = await rpc('notebook_targets', {});
    if (!document.getElementById('nb-send')?.classList.contains('active')) return;
    if (error) { toast('Error: ' + error.message, 'err'); closeSend(); return; }
    SEND.targets = Array.isArray(data) ? data : [];
    renderSend();
  }
  function sessionLabel(x, tz) { return `${tr('Class')} ${x.n} · ${fDay(x.starts_at, x.timezone || tz)}${x.title ? ' — ' + x.title : ''}`; }
  function renderSend(gid) {
    const groups = SEND.targets || [];
    const head = `<div class="cd-sheet-h"><b id="nb-send-h">📒 <span>Send to the group notebook</span></b><button type="button" class="cd-x" data-nb-send="close" aria-label="${H(tr('Close'))}">✕</button></div>`;
    if (!groups.length) { sendBox(head + `<div class="cd-empty">${H(tr("You don't teach any group yet. The notebook belongs to a group: ask your institution to assign you one."))}</div>`); return; }
    const g = groups.find(x => x.id === gid) || groups[0];
    const has = !!handoutText().trim(); const saved = !!(typeof currentResult !== 'undefined' && currentResult && currentResult.id);
    const def = g.next_session || g.today_session || '';
    const opts = (g.sessions || []).map(x => `<option value="${H(x.id)}"${x.id === def ? ' selected' : ''} data-no-i18n>${H(sessionLabel(x, g.timezone))}${x.id === g.today_session ? ' · ' + H(tr('Today')) : x.id === g.next_session ? ' · ' + H(tr('Next')) : ''}</option>`).join('');
    sendBox(head + `<p class="cd-sheet-sub">The student handout goes into the section of the class you choose, as rich text (headings, lists, tables), without answers. The teacher guide never goes into the shared notebook: it is kept as a note that only you and the substitute see.</p>
      <div class="nb-send-form">
        <label class="nb-f"><span>Group</span><select id="nb-send-group" class="member-role">${groups.map(x => `<option value="${H(x.id)}"${x.id === g.id ? ' selected' : ''} data-no-i18n>${H(x.name)}</option>`).join('')}</select></label>
        <label class="nb-f"><span>Class</span><select id="nb-send-session" class="member-role">${opts}<option value="__new"${def ? '' : ' selected'}>${H(tr('➕ A new section without a class'))}</option></select></label>
        <fieldset class="nb-f nb-what"><legend>What to send</legend>
          <label class="nb-radio"><input type="radio" name="nb-send-what" value="student"${has ? ' checked' : ' disabled'}> <span>Student handout (no answers)</span></label>
          ${has ? '' : `<div class="cd-pick-note">${H(tr('The student handout is not ready yet: open the "Student handout" tab and wait a moment.'))}</div>`}
          <label class="nb-radio"><input type="radio" name="nb-send-what" value="guide"${has ? '' : ' checked'}> <span>Teacher guide — as a note only teachers see</span></label>
        </fieldset>
        <label class="nb-check"><input type="checkbox" id="nb-send-attach"${saved && def ? '' : ' disabled'}> <span>Also attach this class plan to the class (the live room shows it to you)</span></label>
        ${saved ? '' : `<div class="gc-hint">${H(tr('Save the class to attach it to a class of the calendar.'))}</div>`}
      </div>
      <div class="nb-send-actions"><button type="button" class="btn-modal-cancel" data-nb-send="close">Cancel</button><button type="button" class="btn-create-inst" data-nb-send="go" id="nb-send-go">📒 <span>Send</span></button></div>`);
  }
  async function doSend(btn) {
    if (typeof vaBlocked === 'function' && vaBlocked()) return;
    const gid = document.getElementById('nb-send-group')?.value; const sv = document.getElementById('nb-send-session')?.value || '__new';
    const what = document.querySelector('input[name="nb-send-what"]:checked')?.value || 'student';
    const attach = !!document.getElementById('nb-send-attach')?.checked && sv !== '__new';
    const g = (SEND.targets || []).find(x => x.id === gid); if (!g) return;
    const r0 = currentResult; const title = String(r0?.title || '').slice(0, 200) || tr('Class');
    btn.disabled = true;
    try {
      const r = await resolve(sv === '__new' ? { group: gid } : { group: gid, session: sv });
      if (!r.notebook_id) throw new Error(tr('Could not open the notebook.'));
      let sec = r.section_id;
      if (sv === '__new' || !sec) {
        const a = await rpc('notebook_add_section', { p_notebook: r.notebook_id, p_title: title, p_session: sv === '__new' ? null : sv, p_today: false });
        if (a.error) throw a.error; sec = a.data?.section_id;
      }
      if (what === 'guide') {
        const body = guideText(); if (!body) throw new Error(tr('Nothing to send yet.'));
        const n = await rpc('notebook_add_note', { p_notebook: r.notebook_id, p_section: sec, p_title: `${tr('Teacher guide')} · ${title}`, p_body: body.slice(0, 200000), p_kind: 'teacher_guide' });
        if (n.error) throw n.error;
      } else {
        const text = handoutText(); if (!text.trim()) throw new Error(tr('The student handout is not ready yet.'));
        await appendToSection(r.notebook_id, sec, handoutToHtml(text, title));
      }
      let attached = false;
      if (attach && r0?.id) { const p = await rpc('set_session_plan', { p_session: sv, p_planning: r0.id }); attached = !p.error; if (p.error) toast('Error: ' + p.error.message, 'err'); }
      const sx = (g.sessions || []).find(x => x.id === sv);
      const where = sx ? sessionLabel(sx, g.timezone) : title;
      sendBox(`<div class="cd-sheet-h"><b id="nb-send-h">✅ <span>${H(tr(what === 'guide' ? 'Teacher note saved' : 'Sent to the notebook'))}</span></b><button type="button" class="cd-x" data-nb-send="close" aria-label="${H(tr('Close'))}">✕</button></div>
        <p class="nb-send-done"><b data-no-i18n>${H(g.name)}</b> · <span data-no-i18n>${H(where)}</span></p>
        <p class="cd-sheet-sub">${H(tr(what === 'guide' ? 'Only you and the substitute see it, inside that section of the notebook.' : 'Everyone in the group sees it in that section of the notebook.'))}${attached ? ' ' + H(tr('The plan was attached to the class.')) : ''}</p>
        <div class="nb-send-actions"><button type="button" class="btn-modal-cancel" data-nb-send="close">Close</button><button type="button" class="btn-create-inst" data-nb-send="open-nb" data-nb-id="${H(r.notebook_id)}" data-sec="${H(sec || '')}">📒 <span>Open notebook</span></button></div>`);
      toast(tr(what === 'guide' ? 'Teacher note saved ✓' : 'Sent to the group notebook ✓'), 'ok');
    } catch (e) {
      btn.disabled = false; toast('Error: ' + dbMsg(e?.message || e), 'err', 6000);
    }
  }
  // append HTML at the end of one section without opening the notebook (headless editor on that section's Yjs document)
  async function appendToSection(nb, secId, html) {
    const [M, res] = await Promise.all([loadEditor(), rpc('notebook_open', { p_notebook: nb })]);
    if (res.error || !res.data) throw res.error || new Error('notebook');
    const p = res.data; const meta = (p.sections || []).find(s => s.id === secId); if (!meta) throw new Error(tr('Could not open the notebook.'));
    const ydoc = new M.Y.Doc();
    if (meta.state) M.Y.applyUpdate(ydoc, fromB64(meta.state));
    (p.updates || []).filter(u => u.s === secId).forEach(u => M.Y.applyUpdate(ydoc, fromB64(u.d)));
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px';
    document.body.appendChild(host);
    const ups = [];
    const ed = new M.Editor({ element: host, extensions: [...EXT(M), M.Collaboration.configure({ document: ydoc })] });
    try {
      await new Promise(r => setTimeout(r, 60)); // y-prosemirror renders the existing content on the next tick
      ydoc.on('update', u => ups.push(u));
      if (ed.isEmpty) ed.commands.setContent(html); else ed.commands.insertContentAt(ed.state.doc.content.size, html);
      await new Promise(r => setTimeout(r, 0));
      if (!ups.length) return;
      const merged = ups.length === 1 ? ups[0] : M.Y.mergeUpdates(ups);
      const { error } = await rpc('notebook_push', { p_notebook: nb, p_section: secId, p_generation: p.generation, p_update: toB64(merged), p_client: 'send' });
      if (error) throw error;
      // tell the open notebooks to read it now (best effort; they also poll)
      try {
        const ch = sb.channel(p.channel.topic, { config: { private: true, broadcast: { self: false, ack: false } } });
        const t = setTimeout(() => { try { sb.removeChannel(ch); } catch (e) { /* ignore */ } }, 4000);
        ch.subscribe(st => { if (st === 'SUBSCRIBED') { try { ch.send({ type: 'broadcast', event: 'poke', payload: {} }); } catch (e) { /* ignore */ } setTimeout(() => { clearTimeout(t); try { sb.removeChannel(ch); } catch (e) { /* ignore */ } }, 300); } });
      } catch (e) { /* polling covers it */ }
    } finally { try { ed.destroy(); } catch (e) { /* ignore */ } try { ydoc.destroy(); } catch (e) { /* ignore */ } host.remove(); }
  }
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-nb-send]'); if (!el) { if (e.target.id === 'nb-send') closeSend(); return; }
    switch (el.dataset.nbSend) {
      case 'open': sendDialog(); break;
      case 'close': closeSend(); break;
      case 'go': doSend(el); break;
      case 'open-nb': closeSend(); open({ notebook: el.dataset.nbId, section: el.dataset.sec || null }); break;
    }
  });
  document.addEventListener('change', e => { if (e.target?.id === 'nb-send-group') renderSend(e.target.value); if (e.target?.id === 'nb-send-session') { const a = document.getElementById('nb-send-attach'); if (a) a.disabled = e.target.value === '__new' || !(typeof currentResult !== 'undefined' && currentResult && currentResult.id); } });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('nb-send')?.classList.contains('active')) { closeSend(); return; }
    if (!overlay || !document.getElementById('nb-overlay')?.classList.contains('active') || document.querySelector('#cd-overlay.active')) return;
    const sh = document.querySelector('#nb-overlay .cd-sheet:not([hidden])');
    if (sh) overlay.closeSheet(); else if (!e.target.closest?.('.ProseMirror')) closeOverlay();
  });
  window.addEventListener('pagehide', () => { if (overlay) overlay.flush(); });

  window.TCNotebook = { open, close: closeOverlay, mount, ensureSession, classEnd, onDocShown, sendDialog, _test: { secLabel, get view() { return overlay; } } };

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // SPANISH (rioplatense "vos")
  // ════════════════════════════════════════════════════════════════════════════════════════════
  if (typeof DB_ERRORS !== 'undefined') DB_ERRORS.unshift(
    [/El docente bloqueó el cuaderno/, 'The teacher locked the notebook.'], [/El docente bloqueó las clases anteriores del cuaderno/, 'The teacher locked the past classes of the notebook.'],
    [/Solo lectura: no podés editar este cuaderno/, 'Read-only: you cannot edit this notebook.'], [/Cuaderno desactualizado: volvé a abrirlo/, 'The notebook changed: open it again.'],
    [/El cuaderno llegó a su tamaño máximo.*$/, 'The notebook reached its maximum size (8 MB): delete content you no longer need to keep writing.'],
    [/Sección inválida/, 'Invalid section.'], [/Escribí un título para la sección/, 'Write a title for the section.'], [/Esa clase no es de este cuaderno/, 'That class does not belong to this notebook.'],
    [/El cuaderno ya tiene demasiadas secciones/, 'The notebook already has too many sections.'], [/Nota inválida/, 'Invalid note.'], [/El cuaderno ya tiene demasiadas notas docentes/, 'The notebook already has too many teacher notes.'],
    [/Año inválido/, 'Invalid year.'], [/Mes inválido.*$/, 'Invalid month (1 to 12).']
  );
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'Group notebook': 'Cuaderno del grupo', 'Notebook': 'Cuaderno', 'notebook': 'cuaderno', 'class': 'clase', 'Class': 'Clase', 'Notes': 'Notas', 'Section': 'Sección', 'Today': 'Hoy', 'Next': 'Próxima',
    'Opening the group notebook…': 'Abriendo el cuaderno del grupo…', "You don't have access to this notebook.": 'No tenés acceso a este cuaderno.', 'Could not open the notebook.': 'No se pudo abrir el cuaderno.',
    'School year': 'Año lectivo', 'Teacher:': 'Docente:', 'One section per class; everyone in the group writes in it.': 'Una sección por clase; todo el grupo escribe en él.',
    'People in the notebook': 'Personas en el cuaderno', 'Lock the whole notebook for students': 'Bloquear todo el cuaderno para estudiantes', 'Lock only past classes': 'Bloquear solo las clases anteriores',
    'Locked for students': 'Bloqueado para estudiantes', 'Past classes locked': 'Clases anteriores bloqueadas', 'Lock…': 'Bloquear…',
    "Add today's section": 'Agregar sección de hoy', 'Whole notebook': 'Todo el cuaderno', 'This section': 'Esta sección', 'Go to': 'Ir a', 'Classes in this notebook': 'Clases de este cuaderno', 'Classes': 'Clases',
    "No sections yet: each class gets its section when it starts. Add today's to start writing.": 'Todavía no hay secciones: cada clase tiene la suya cuando empieza. Agregá la de hoy para empezar a escribir.',
    'No sections yet: each class gets its section when it starts.': 'Todavía no hay secciones: cada clase tiene la suya cuando empieza.',
    'Previous document of this class': 'Documento anterior de esta clase', 'Import the previous document into this section': 'Importar documento anterior a esta sección',
    'Click again to add it at the end of this section': 'Hacé clic de nuevo para agregarlo al final de esta sección', 'The previous document is empty.': 'El documento anterior está vacío.',
    'Previous document imported into this section ✓ (the original is kept).': 'Documento anterior importado a esta sección ✓ (el original se conserva).',
    'Write here… Everyone in the group sees it as you type.': 'Escribí acá… Todo el grupo lo ve mientras escribís.', 'Nothing written in this class yet.': 'Todavía no se escribió nada en esta clase.',
    'A previous version of the notebook was restored.': 'Se restauró una versión anterior del cuaderno.',
    'Read-only: institution admins can read the group notebook but not edit it.': 'Solo lectura: los admins de la institución pueden leer el cuaderno del grupo pero no editarlo.',
    'The teacher locked the notebook: you can read it but not edit it.': 'El docente bloqueó el cuaderno: podés leerlo pero no editarlo.',
    "Past classes are locked: you can write in today's and upcoming classes.": 'Las clases anteriores están bloqueadas: podés escribir en la de hoy y en las próximas.',
    'Past classes are locked for students.': 'Las clases anteriores están bloqueadas para los estudiantes.',
    'The notebook is almost full': 'El cuaderno está casi lleno', 'Delete content you no longer need, or export it and start a new section.': 'Borrá contenido que ya no uses, o exportalo y empezá una sección nueva.',
    'The notebook reached its maximum size (8 MB): delete content you no longer need to keep writing.': 'El cuaderno llegó a su tamaño máximo (8 MB): borrá contenido que ya no uses para seguir escribiendo.',
    'Notebook full: not saved': 'Cuaderno lleno: no se guardó', 'The teacher locked the notebook: your last change was not saved.': 'El docente bloqueó el cuaderno: tu último cambio no se guardó.',
    'The teacher locked the notebook.': 'El docente bloqueó el cuaderno.', 'The teacher locked the past classes of the notebook.': 'El docente bloqueó las clases anteriores del cuaderno.',
    'The teacher unlocked the notebook: you can edit again.': 'El docente desbloqueó el cuaderno: podés editar de nuevo.',
    "Past classes locked: students write only in today's and upcoming classes.": 'Clases anteriores bloqueadas: los estudiantes escriben solo en la de hoy y en las próximas.',
    "Today's section added ✓": 'Sección de hoy agregada ✓', "Today's section was already there.": 'La sección de hoy ya estaba.', "Add today's section first.": 'Primero agregá la sección de hoy.',
    'We insert the': 'Insertamos el', 'of the class (without answers or teacher notes) into the section:': 'de la clase (sin respuestas ni notas docentes) en la sección:',
    'The teacher guide is never shared here.': 'La guía docente nunca se comparte acá.',
    'Teacher notes': 'Notas docentes', 'Only you and the substitute see them.': 'Solo las ven vos y el suplente.', 'Teacher guide': 'Guía docente', 'Delete note': 'Borrar nota', 'Delete?': '¿Borrar?',
    'Versions of the whole notebook are saved every 10 minutes while people write, at the end of each class and when you save one. Open one to see it; you can restore it.': 'Las versiones de todo el cuaderno se guardan cada 10 minutos mientras se escribe, al terminar cada clase y cuando guardás una. Abrí una para verla; podés restaurarla.',
    'Versions of the whole notebook are saved every 10 minutes while people write and at the end of each class. Only the teacher can restore one.': 'Las versiones de todo el cuaderno se guardan cada 10 minutos mientras se escribe y al terminar cada clase. Solo el docente puede restaurar una.',
    'The notebook is empty: nothing to save yet.': 'El cuaderno está vacío: todavía no hay nada para guardar.',
    'This group has no notebook for this school year yet: it is created when the teacher or a student opens it.': 'Este grupo todavía no tiene cuaderno para este año lectivo: se crea cuando lo abre el docente o un estudiante.',
    'This group has no notebook for this school year yet.': 'Este grupo todavía no tiene cuaderno para este año lectivo.',
    'Send to the group notebook': 'Enviar al cuaderno del grupo', 'Generate a lesson plan first.': 'Primero generá un plan de clase.',
    "You don't teach any group yet. The notebook belongs to a group: ask your institution to assign you one.": 'Todavía no das clase en ningún grupo. El cuaderno es de un grupo: pedile a tu institución que te asigne uno.',
    'The student handout goes into the section of the class you choose, as rich text (headings, lists, tables), without answers. The teacher guide never goes into the shared notebook: it is kept as a note that only you and the substitute see.': 'El material del alumno va a la sección de la clase que elijas, con formato (títulos, listas, tablas) y sin respuestas. La guía docente nunca va al cuaderno compartido: queda como una nota que solo ven vos y el suplente.',
    'Group': 'Grupo', 'What to send': 'Qué enviar', '➕ A new section without a class': '➕ Una sección nueva sin clase',
    'Student handout (no answers)': 'Material del alumno (sin respuestas)', 'Teacher guide — as a note only teachers see': 'Guía docente — como nota que solo ven los docentes',
    'The student handout is not ready yet: open the "Student handout" tab and wait a moment.': 'El material del alumno todavía no está listo: abrí la pestaña "Material del alumno" y esperá un momento.',
    'Also attach this class plan to the class (the live room shows it to you)': 'Adjuntar también este plan a la clase (la sala en vivo te lo muestra)',
    'Save the class to attach it to a class of the calendar.': 'Guardá la clase para adjuntarla a una clase del calendario.', 'Send': 'Enviar', 'Cancel': 'Cancelar',
    'Teacher note saved': 'Nota docente guardada', 'Sent to the notebook': 'Enviado al cuaderno', 'Open notebook': 'Abrir cuaderno',
    'Only you and the substitute see it, inside that section of the notebook.': 'Solo la ven vos y el suplente, dentro de esa sección del cuaderno.',
    'Everyone in the group sees it in that section of the notebook.': 'Todo el grupo lo ve en esa sección del cuaderno.', 'The plan was attached to the class.': 'El plan quedó adjunto a la clase.',
    'Teacher note saved ✓': 'Nota docente guardada ✓', 'Sent to the group notebook ✓': 'Enviado al cuaderno del grupo ✓', 'Nothing to send yet.': 'Todavía no hay nada para enviar.',
    'The student handout is not ready yet.': 'El material del alumno todavía no está listo.',
    'The teacher locked the past classes of the notebook.': 'El docente bloqueó las clases anteriores del cuaderno.', 'Read-only: you cannot edit this notebook.': 'Solo lectura: no podés editar este cuaderno.',
    'The notebook changed: open it again.': 'El cuaderno cambió: volvé a abrirlo.', 'Invalid section.': 'Sección inválida.', 'Write a title for the section.': 'Escribí un título para la sección.',
    'That class does not belong to this notebook.': 'Esa clase no es de este cuaderno.', 'The notebook already has too many sections.': 'El cuaderno ya tiene demasiadas secciones.',
    'Invalid note.': 'Nota inválida.', 'The notebook already has too many teacher notes.': 'El cuaderno ya tiene demasiadas notas docentes.', 'Invalid year.': 'Año inválido.', 'Invalid month (1 to 12).': 'Mes inválido (de 1 a 12).',
    // shared with the class document (defined here too so the notebook works on its own)
    'History': 'Historial', 'Export': 'Exportar', 'Close': 'Cerrar', 'Loading…': 'Cargando…', 'Paste a class': 'Pegar una clase', 'Print / PDF': 'Imprimir / PDF', 'Download HTML': 'Descargar HTML',
    'Download Markdown': 'Descargar Markdown', 'Formatting': 'Formato', 'Heading 1': 'Título 1', 'Heading 2': 'Título 2', 'Heading 3': 'Título 3', 'Normal text': 'Texto normal', 'Bold': 'Negrita',
    'Italic': 'Cursiva', 'Strikethrough': 'Tachado', 'Bulleted list': 'Lista con viñetas', 'Numbered list': 'Lista numerada', 'Quote': 'Cita', 'Link': 'Enlace', 'Insert table': 'Insertar tabla',
    'Add row': 'Agregar fila', 'Add column': 'Agregar columna', 'Delete row': 'Borrar fila', 'Delete column': 'Borrar columna', 'Delete table': 'Borrar tabla', 'Undo': 'Deshacer', 'Redo': 'Rehacer',
    'Unlock for students': 'Desbloquear para estudiantes', 'View as is read-only.': '"Ver como" es solo lectura.', 'Locked for students: only you (and the substitute) can edit.': 'Bloqueado para estudiantes: solo vos (y el suplente) pueden editar.',
    'Connection problem: retrying…': 'Problema de conexión: reintentando…', 'Saving…': 'Guardando…', '● Live': '● En vivo', 'Live sync unavailable: updates every few seconds': 'Sincronización en vivo no disponible: se actualiza cada pocos segundos',
    'Updates every few seconds': 'Se actualiza cada pocos segundos', 'Read-only': 'Solo lectura', 'All changes saved': 'Todos los cambios guardados', 'you': 'vos', 'person here': 'persona acá', 'people here': 'personas acá',
    'Link address (https://…). Leave it empty to remove the link.': 'Dirección del enlace (https://…). Dejala vacía para quitar el enlace.', 'Invalid link.': 'Enlace inválido.',
    'Locked: students can read but not edit.': 'Bloqueado: los estudiantes pueden leer pero no editar.', 'Unlocked: students can edit again.': 'Desbloqueado: los estudiantes pueden editar de nuevo.',
    'No student handout yet: open it in Classes and the handout is prepared there.': 'Todavía no tiene material del alumno: abrila en Clases y el material se prepara ahí.', 'Insert': 'Insertar',
    'student handout': 'material del alumno', "You don't have saved classes yet. Create one in Classes and save it.": 'Todavía no tenés clases guardadas. Creá una en Clases y guardala.', 'Student handout inserted ✓': 'Material del alumno insertado ✓',
    'Could not load the history.': 'No se pudo cargar el historial.', 'Automatic': 'Automática', 'End of class': 'Fin de la clase', 'Saved by the teacher': 'Guardada por el docente', 'Before a restore': 'Antes de restaurar',
    'Save a version now': 'Guardar una versión ahora', 'No versions yet.': 'Todavía no hay versiones.', 'Restore this version': 'Restaurar esta versión', 'Click again: everyone sees this version': 'Hacé clic de nuevo: todos van a ver esta versión',
    'Version restored ✓': 'Versión restaurada ✓', 'Version saved ✓': 'Versión guardada ✓', 'Reader': 'Lector',
    'Could not load the editor. Check your connection and try again.': 'No se pudo cargar el editor. Revisá tu conexión y probá de nuevo.',
  });
})();
