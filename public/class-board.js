/* TeroClass · Class whiteboard ("Pizarra"): one shared drawing board per calendar class
 * ------------------------------------------------------------------------------------------
 * Everyone in the class (teacher, substitute, enrolled / invited students) draws at the same time; the teacher can lock it
 * (students only look) and restore a previous version. Institution admins of the unit and the super admin: read-only.
 * It stays as a record after the class. Export: PNG / SVG (Excalidraw's own export).
 *
 * Library: Excalidraw 0.18.1 + React 18.3.1 (MIT), vendored as ONE pinned ES module + lazy chunks in public/vendor/whiteboard/
 * (built once by scripts/vendor/build-whiteboard.sh; loaded with import() only when a board is opened). Its fonts are served
 * from /vendor/whiteboard/fonts (window.EXCALIDRAW_ASSET_PATH): nothing comes from a CDN, the CSP stays strict.
 * The app has no build step: the component is rendered with React.createElement (no JSX).
 *
 * Sync (all access checked in the database: supabase/migrations/001_base.sql, "PIZARRA DE LA CLASE"):
 *   · every local change → classboard_push (only the elements that changed, ~300 ms debounce; the database validates each
 *     element, keeps the highest version per element — same version: the lowest versionNonce, like Excalidraw — and the 2 MB cap);
 *   · Supabase Realtime PRIVATE channel "classboard:<session id>": the changed elements travel there too, so the others see a
 *     stroke while it is drawn, plus pointers. A browser NEVER saves what it received: it only applies it on screen (after the
 *     same type / size checks) and reconciles it with reconcileElements; what is stored is what each author pushed through the
 *     RPC. Fallback: a public channel with an unguessable name (only "changes, pull" pokes and pointers, never drawings);
 *     without Realtime: classboard_pull every 2 s.
 *   · images and embedded web pages are disabled (tool hidden, pasted / dropped ones removed, refused by the database).
 * Names / colours of the people on the board come from the database (never from other browsers).
 * Depends on globals from index.html: sb, viewAs, esc, showToast, trText, uiLang, uiLocale, I18N_ES, DB_ERRORS, vaBlocked, dbErr.
 */
(function () {
  'use strict';

  const BUNDLE = '/vendor/whiteboard/whiteboard.js';
  const CSS_URL = '/vendor/whiteboard/excalidraw.css';
  const ASSETS = '/vendor/whiteboard/';
  const POLL_MS = 2000, POLL_RT_MS = 10000, POLL_HIDDEN_MS = 8000;
  const PUSH_MS = 300, PUSH_MAX_WAIT_MS = 1200, BCAST_MS = 70, PTR_MS = 60;
  const MAX_BCAST = 100000;              // larger changes are announced with a poke and read from the database
  const MAX_EL_BYTES = 262144;           // same limit as the database
  const ALLOWED = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'frame']);
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const toast = (m, t, ms) => { if (typeof showToast === 'function') showToast(m, t, ms); };
  const dbMsg = m => (typeof dbErr === 'function' ? dbErr(String(m || '')) : String(m || ''));
  const inViewAs = () => typeof viewAs !== 'undefined' && !!viewAs;
  const H = s => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const loc = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  const lang = () => (typeof uiLang !== 'undefined' && uiLang === 'es' ? 'es' : 'en');
  const fDT = d => { try { return new Date(d).toLocaleString(loc(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(lang() === 'es' ? { hourCycle: 'h23' } : {}) }); } catch (e) { return ''; } };
  const initials = n => (String(n || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
  const safeColor = c => (COLOR_RE.test(String(c || '')) ? c : '#7c5cbf');
  const fmtMB = b => (Math.round((Number(b) || 0) / 104857.6) / 10).toLocaleString(loc());
  const randomId = () => { const a = new Uint8Array(8); (window.crypto || {}).getRandomValues?.(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join('') || String(Math.random()).slice(2, 18); };
  const fileBase = info => (String(info?.session?.title || 'pizarra').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'pizarra')
    + '-' + String(info?.session?.starts_at || '').slice(0, 10);

  // ── the vendored library (+ its stylesheet), loaded once, on demand ──
  let modP = null;
  function loadCss() {
    let l = document.getElementById('tc-excalidraw-css');
    if (l) return l.__ready || Promise.resolve();
    l = document.createElement('link'); l.id = 'tc-excalidraw-css'; l.rel = 'stylesheet'; l.href = CSS_URL;
    l.__ready = new Promise(res => { l.onload = res; l.onerror = res; setTimeout(res, 8000); });
    document.head.appendChild(l); return l.__ready;
  }
  function loadLib() {
    if (!modP) {
      window.EXCALIDRAW_ASSET_PATH = location.origin + ASSETS; // fonts from our own server (CSP: font-src 'self')
      modP = Promise.all([import(BUNDLE), loadCss()]).then(([m]) => m).catch(e => { modP = null; throw e; });
    }
    return modP;
  }

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args || {});
    let d = data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* keep */ } }
    return { data: d, error };
  }
  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }
  // an element received from another browser or the database: shape checks before it is drawn (the database already
  // validated what it stores; a broadcast is only trusted this far)
  function validEl(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (!ID_RE.test(String(e.id || '')) || !ALLOWED.has(e.type)) return false;
    if (!Number.isInteger(e.version) || e.version < 1 || !Number.isFinite(e.versionNonce)) return false;
    if (e.fileId) return false;
    try { if (JSON.stringify(e).length > MAX_EL_BYTES) return false; } catch (x) { return false; }
    return true;
  }
  const cleanOut = e => { const o = { ...e }; delete o.customData; return o; };

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // BoardView: one open board (full-screen overlay or the live-class side panel)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  let seq = 0;
  class BoardView {
    constructor(host, sessionId, opts = {}) {
      this.host = host; this.sid = sessionId; this.opts = opts; this.id = 'cb' + (++seq);
      this.cid = randomId();                    // this browser tab on this board (presence / pointers)
      this.known = new Map();                   // element id → version already synced (sent or received)
      this.pending = new Map();                 // id → element waiting for classboard_push
      this.outbox = new Map();                  // id → element waiting to be broadcast
      this.remote = new Map();                  // client id → {name, color, role, pointer, button}
      this.bcAt = new Map();                    // id → {t, v}: drawn from a broadcast, not yet confirmed by the database
      this.timers = {}; this.rev = 0; this.gen = 1; this.pushing = false; this.pulling = false; this.pullAgain = false;
      this.rt = null; this.channel = null; this.dead = false; this.status = 'loading'; this.full = false; this.pointer = null;
      this.onVis = () => this.schedulePull(50);
      this.onClick = e => this.click(e);
    }
    get canEdit() { return !!this.info?.can_edit && !inViewAs(); }
    get isTeacher() { return this.info?.role === 'teacher' && !inViewAs(); }
    get participant() { return (this.info?.role === 'teacher' || this.info?.role === 'student') && !inViewAs(); }

    async init() {
      this.host.innerHTML = `<div class="cd-shell cb-shell${this.opts.compact ? ' compact' : ''}" id="${this.id}"><div class="cd-loading">${H(tr('Opening the board…'))}</div></div>`;
      this.host.addEventListener('click', this.onClick);
      this.onPageSel = e => { if (e.target?.dataset?.cbChange === 'page') this.goPage(e.target.value); };
      this.host.addEventListener('change', this.onPageSel);
      let M, res, pg;
      // the group board: one page per class of the school year (each page is that class's board); a one-off class has none
      const pagesP = this.opts.pages === false ? Promise.resolve({ data: null }) : (this.opts.pagesData ? Promise.resolve({ data: this.opts.pagesData }) : rpc('groupboard_pages', { p_session: this.sid }).catch(() => ({ data: null })));
      try { [M, res, pg] = await Promise.all([loadLib(), rpc('classboard_open', { p_session: this.sid }), pagesP]); }
      catch (e) { console.warn('classboard library', e); return this.fail(tr('Could not load the board. Check your connection and try again.')); }
      if (this.dead) return null;
      if (res.error || !res.data) return this.fail(/No autorizado/.test(res.error?.message || '') ? tr("You don't have access to this board.") : tr('Could not open the board.') + ' ' + (res.error?.message || ''));
      this.M = M; this.info = res.data; this.gen = res.data.generation || 1; this.rev = Number(res.data.rev) || 0;
      this.pages = pg && pg.data && Array.isArray(pg.data.pages) && pg.data.pages.length ? pg.data : null;
      this.renderShell();
      this.mountExcalidraw(res.data.elements || []);
      document.addEventListener('visibilitychange', this.onVis);
      this.connectRealtime();
      this.schedulePull(this.participant ? 400 : 1500);
      this.updateUi();
      return this;
    }
    fail(msg) {
      this.status = 'error';
      this.host.innerHTML = `<div class="cd-shell cb-shell${this.opts.compact ? ' compact' : ''}"><div class="cd-fail" role="alert"><span aria-hidden="true">🖍️</span><p data-no-i18n>${H(msg)}</p>${this.opts.compact ? '' : `<button type="button" class="tree-btn" data-cb="close">${H(tr('Close'))}</button>`}</div></div>`;
      return null;
    }

    // ── shell ──
    renderShell() {
      const s = this.info.session || {}; const c = !!this.opts.compact;
      this.host.querySelector('.cb-shell').innerHTML = `
        <header class="cd-head cb-head">
          <div class="cd-head-main">
            ${c ? '' : `<div class="cd-kicker"><span aria-hidden="true">🖍️</span> <span>Class board</span></div>`}
            <div class="cd-title" data-no-i18n>${H(s.title || '')}</div>
            <div class="cd-meta"><span data-no-i18n>${H(s.group_name || '')}</span>${s.group_name ? ' · ' : ''}<span data-no-i18n>${H(fDT(s.starts_at))}</span></div>
          </div>
          <div class="cd-people" aria-label="${H(tr('People on the board'))}"></div>
          <div class="cd-status" role="status" aria-live="polite" data-no-i18n></div>
          <div class="cd-actions">
            <button type="button" class="tree-btn cd-lock" data-cb="lock" hidden></button>
            <button type="button" class="tree-btn" data-cb="history">🕘 <span>History</span></button>
            <div class="cd-menu-wrap"><button type="button" class="tree-btn" data-cb="export-menu" aria-haspopup="true" aria-expanded="false">⬇ <span>Export</span></button>
              <div class="cd-menu" role="menu" hidden>
                <button type="button" role="menuitem" data-cb="png">🖼 <span>Download PNG</span></button>
                <button type="button" role="menuitem" data-cb="svg">⬇ <span>Download SVG</span></button>
              </div></div>
            ${c && this.opts.onExpand ? `<button type="button" class="tree-btn cb-expand" data-cb="expand" aria-pressed="false"></button>` : ''}
            ${c ? '' : `<button type="button" class="tree-btn cd-close" data-cb="close" aria-label="${H(tr('Close'))}">✕ <span>Close</span></button>`}
          </div>
        </header>
        ${this.pagesHtml()}
        <div class="cd-notice" role="status" hidden></div>
        <div class="cb-canvas" data-no-i18n></div>
        <div class="cd-sheet" hidden></div>`;
    }
    // page selector of the group board ("Class 12 · Mon 3 Mar"; today marked; ‹ › and "Today")
    pagesHtml() {
      const P = this.pages; if (!P) return '';
      const list = P.pages; const i = list.findIndex(p => p.session_id === this.sid);
      const day = p => { try { return new Date(p.starts_at).toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: p.timezone || P.timezone || undefined }).replace(/\./g, '').replace(lang() === 'es' ? /,/g : /^$/, ''); } catch (e) { return ''; } };
      const label = p => `${tr('Class')} ${p.n} · ${day(p)}${p.today ? ' · ' + tr('Today') : ''}${p.has_board ? '' : ' · ' + tr('blank')}`;
      return `<div class="cb-pages" role="navigation" aria-label="${H(tr('Board pages'))}">
        <span class="cb-pages-k">🖍️ <span>${H(tr('Group board'))}</span> · <span data-no-i18n>${H(P.group_name || '')} · ${H(P.year_label || P.year || '')}</span></span>
        <button type="button" class="tree-btn cb-pg-btn" data-cb="page-prev" aria-label="${H(tr('Previous page'))}"${i > 0 ? '' : ' disabled'}>‹</button>
        <label class="sr-only" for="${this.id}-page">${H(tr('Page'))}</label>
        <select id="${this.id}-page" class="cb-page-sel" data-cb-change="page">${list.map(p => `<option value="${H(p.session_id)}"${p.session_id === this.sid ? ' selected' : ''} data-no-i18n>${H(label(p))}</option>`).join('')}</select>
        <button type="button" class="tree-btn cb-pg-btn" data-cb="page-next" aria-label="${H(tr('Next page'))}"${i >= 0 && i < list.length - 1 ? '' : ' disabled'}>›</button>
        ${P.today_session && P.today_session !== this.sid ? `<button type="button" class="tree-btn cb-pg-today" data-cb="page-today">${H(tr('Today'))}</button>` : ''}
        <span class="cb-pages-n" data-no-i18n>${i >= 0 ? `${i + 1} / ${list.length}` : ''}</span>
      </div>`;
    }
    goPage(sid) {
      if (!sid || sid === this.sid || this.dead || !this.pages || !this.pages.pages.some(p => p.session_id === sid)) return;
      swapPage(this, sid);
    }
    updateUi() {
      const root = this.host.querySelector('.cb-shell'); if (!root || !this.info) return;
      const i = this.info;
      root.classList.toggle('readonly', !this.canEdit);
      const lock = root.querySelector('[data-cb="lock"]');
      if (lock) { lock.hidden = !this.isTeacher; lock.innerHTML = i.locked ? `🔓 <span>${H(tr('Unlock for students'))}</span>` : `🔒 <span>${H(tr('Lock for students'))}</span>`; lock.setAttribute('aria-pressed', String(!!i.locked)); }
      const ex = root.querySelector('[data-cb="expand"]');
      if (ex) { ex.innerHTML = this.full ? `🗗 <span>${H(tr('Exit full screen'))}</span>` : `⛶ <span>${H(tr('Full screen'))}</span>`; ex.setAttribute('aria-pressed', String(this.full)); ex.title = tr(this.full ? 'Exit full screen' : 'Full screen'); }
      const n = root.querySelector('.cd-notice');
      let msg = '', cls = '';
      if (inViewAs()) msg = tr('View as is read-only.');
      else if (i.role === 'admin') msg = tr('Read-only: institution admins can see the board but not draw on it.');
      else if (i.locked && i.role === 'student') { msg = tr('The teacher locked the board: you can look but not draw.'); cls = ' locked'; }
      else if (i.locked) { msg = tr('Locked for students: only you (and the substitute) can draw.'); cls = ' locked'; }
      else if (this.status === 'full') { msg = tr('The board is full (2 MB): delete drawings you no longer need to keep drawing.'); cls = ' locked'; }
      else if ((Number(i.bytes) || 0) > 0.8 * (Number(i.max_bytes) || 2097152)) msg = tr('The board is almost full') + ` (${fmtMB(i.bytes)} / 2 MB).`;
      if (n) { n.hidden = !msg; n.textContent = msg; n.className = 'cd-notice' + cls; }
      this.renderApp(); this.renderStatus(); this.renderPeople();
    }
    renderStatus() {
      const el = this.host.querySelector('.cd-status'); if (!el) return;
      let cls = 'cd-status', txt;
      if (this.status === 'offline') { cls += ' err'; txt = tr('Connection problem: retrying…'); }
      else if (this.status === 'full') { cls += ' err'; txt = tr('Board full: not saved'); }
      else if (this.pending.size || this.pushing) { cls += ' saving'; txt = tr('Saving…'); }
      else if (this.rt) { cls += ' live'; txt = tr('● Live'); }
      else { cls += ' poll'; txt = tr('Live sync unavailable: updates every few seconds'); }
      if (!this.canEdit && this.status !== 'offline') txt = (this.rt ? tr('● Live') : tr('Updates every few seconds')) + ' · ' + tr('Read-only');
      el.className = cls; el.textContent = txt;
      el.title = !this.pending.size && !this.pushing && this.canEdit && this.status === 'ok' ? tr('All changes saved') : '';
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

    // ── Excalidraw ──
    mountExcalidraw(elements) {
      const M = this.M;
      const restored = M.restoreElements((elements || []).filter(validEl), null);
      restored.forEach(e => this.known.set(e.id, e.version));
      this.initialData = { elements: restored, appState: { viewBackgroundColor: '#ffffff', currentItemRoughness: 0, currentItemFontFamily: 5 }, scrollToContent: true };
      this.canvasEl = this.host.querySelector('.cb-canvas');
      this.root = M.createRoot(this.canvasEl);
      this.renderApp();
    }
    renderApp() {
      if (!this.root || this.dead) return;
      const { React, Excalidraw, MainMenu, WelcomeScreen } = this.M; const h = React.createElement;
      const edit = this.canEdit; const teacher = this.isTeacher;
      const menu = h(MainMenu, null,
        h(MainMenu.DefaultItems.SaveAsImage),
        edit ? h(MainMenu.DefaultItems.ChangeCanvasBackground) : null,
        teacher && edit ? h(MainMenu.DefaultItems.ClearCanvas) : null,
        h(MainMenu.DefaultItems.Help));
      const welcome = edit ? h(WelcomeScreen, null, h(WelcomeScreen.Hints.ToolbarHint), h(WelcomeScreen.Hints.MenuHint), h(WelcomeScreen.Hints.HelpHint)) : null;
      this.root.render(h(Excalidraw, {
        excalidrawAPI: api => { if (api && !this.api) { this.api = api; this.afterApi(); } },
        initialData: this.initialData,
        onChange: els => this.onChange(els),
        onPointerUpdate: p => this.onPointer(p),
        onPaste: data => this.onPaste(data),
        viewModeEnabled: !edit,
        isCollaborating: true,
        langCode: lang() === 'es' ? 'es-ES' : 'en',
        theme: 'light',
        name: this.info?.session?.title || 'TeroClass',
        aiEnabled: false,
        validateEmbeddable: false,
        handleKeyboardGlobally: false,
        autoFocus: false,
        detectScroll: true,
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true, clearCanvas: teacher && edit, toggleTheme: null, changeViewBackgroundColor: edit }, tools: { image: false } },
      }, menu, welcome));
    }
    afterApi() {
      // from here on, every scene change goes through onChange; remote collaborators are drawn by Excalidraw
      this.applyCollaborators();
    }

    // ── local changes → push (database) + broadcast (others' screens) ──
    collectLocal(elements) {
      if (!this.canEdit) return 0;
      let n = 0; const bad = [];
      for (const el of elements) {
        if (!ALLOWED.has(el.type)) { if (!el.isDeleted) bad.push(el); continue; }
        if (this.known.get(el.id) === el.version) continue;
        this.known.set(el.id, el.version);
        this.pending.set(el.id, el); this.outbox.set(el.id, el); n++;
      }
      if (bad.length) this.dropForbidden(bad);
      if (n) { this.schedulePush(); this.scheduleBroadcast(); }
      return n;
    }
    onChange(elements) {
      if (this.dead || !this.api) return;
      const v = this.M.getSceneVersion(elements);
      if (v === this.lastSceneVersion) return;
      this.lastSceneVersion = v;
      this.collectLocal(elements);
    }
    dropForbidden(bad) {
      // images / embedded pages (pasted, dropped or from a library): not available on the board → removed right away
      const ids = new Set(bad.map(e => e.id));
      setTimeout(() => {
        if (!this.api || this.dead) return;
        const els = this.api.getSceneElementsIncludingDeleted().filter(e => !ids.has(e.id));
        this.api.updateScene({ elements: els, captureUpdate: this.M.CaptureUpdateAction.NEVER });
      }, 0);
      if (!this.imgWarned) { this.imgWarned = true; toast(tr('Images are not available on the board yet.'), 'err', 5000); }
    }
    onPaste(data) {
      if (data && Array.isArray(data.elements) && data.elements.some(e => e && !ALLOWED.has(e.type))) { toast(tr('Images are not available on the board yet.'), 'err', 5000); return false; }
      return true;
    }
    schedulePush() {
      this.renderStatus();
      if (!this.pushFirst) this.pushFirst = Date.now();
      clearTimeout(this.timers.push);
      const wait = Date.now() - this.pushFirst > PUSH_MAX_WAIT_MS ? 0 : PUSH_MS;
      this.timers.push = setTimeout(() => this.flush(), wait);
    }
    async flush() {
      if (this.dead || this.pushing || !this.pending.size) return;
      if (!this.canEdit) { this.pending.clear(); this.renderStatus(); return; }
      if (this.status === 'full' && !this.capRetry) return;
      this.capRetry = false; this.pushFirst = 0;
      const batch = [...this.pending.values()].map(cleanOut); this.pending.clear(); this.pushing = true; this.renderStatus();
      const { data, error } = await rpc('classboard_push', { p_session: this.sid, p_generation: this.gen, p_elements: batch, p_client: this.cid });
      this.pushing = false;
      if (this.dead) return;
      if (error) {
        const m = error.message || '';
        batch.forEach(e => { if (!this.pending.has(e.id)) this.pending.set(e.id, e); });
        if (/bloque/i.test(m)) { this.pending.clear(); toast(tr('The teacher locked the board: your last change was not saved.'), 'err', 5000); this.info.locked = true; this.info.can_edit = false; this.reload(); return; }
        if (/desactualizada/i.test(m)) { this.pending.clear(); this.reload(); return; }
        if (/Solo lectura|No autorizado/.test(m)) { this.pending.clear(); this.info.can_edit = false; this.updateUi(); return; }
        if (/tamaño máximo/.test(m)) { this.status = 'full'; this.updateUi(); if (!this.fullWarned) { this.fullWarned = true; toast(dbMsg(m), 'err', 9000); } return; }
        if (/imágenes|no permitido/i.test(m)) { this.pending.clear(); toast(dbMsg(m), 'err', 6000); this.renderStatus(); return; }
        this.status = 'offline'; this.renderStatus();
        clearTimeout(this.timers.push); this.timers.push = setTimeout(() => this.flush(), 3000); return;
      }
      if (this.status === 'offline' || this.status === 'full' || this.status === 'loading') this.status = 'ok';
      this.send('poke', { g: this.gen });
      this.renderStatus();
      if (this.pending.size) this.schedulePush();
    }
    scheduleBroadcast() {
      if (this.timers.bc) return;
      this.timers.bc = setTimeout(() => { this.timers.bc = null; this.broadcast(); }, BCAST_MS);
    }
    broadcast() {
      if (!this.outbox.size) return;
      const els = [...this.outbox.values()].map(cleanOut); this.outbox.clear();
      // drawings travel only on the PRIVATE channel (authorized by the database); the public fallback only gets a poke
      if (this.rt !== 'private' || this.status === 'full') return;
      let payload = null; try { payload = JSON.stringify(els); } catch (e) { return; }
      if (payload.length > MAX_BCAST) return; // the poke after the push makes the others read it from the database
      this.send('els', { c: this.cid, g: this.gen, e: els });
    }

    // ── remote changes (database or broadcast) → reconcile into the scene ──
    applyRemote(list) {
      const api = this.api; if (!api || this.dead) return;
      const incoming = (list || []).filter(validEl); if (!incoming.length) return;
      const M = this.M;
      this.collectLocal(api.getSceneElementsIncludingDeleted()); // local edits not yet seen by onChange stay local edits
      const restored = M.restoreElements(incoming, null);
      const merged = M.reconcileElements(api.getSceneElementsIncludingDeleted(), restored, api.getAppState());
      merged.forEach(e => { if (!this.pending.has(e.id)) this.known.set(e.id, e.version); });
      api.updateScene({ elements: merged, captureUpdate: M.CaptureUpdateAction.NEVER });
      this.lastSceneVersion = M.getSceneVersion(api.getSceneElementsIncludingDeleted());
    }
    resetScene(elements) {
      const api = this.api; if (!api) return;
      const M = this.M;
      const restored = M.restoreElements((elements || []).filter(validEl), null);
      this.pending.clear(); this.outbox.clear(); this.known.clear(); this.bcAt.clear();
      restored.forEach(e => this.known.set(e.id, e.version));
      api.updateScene({ elements: restored, captureUpdate: M.CaptureUpdateAction.NEVER });
      try { api.history.clear(); } catch (e) { /* older API */ }
      this.lastSceneVersion = M.getSceneVersion(restored);
    }
    async reload(why) {
      const { data, error } = await rpc('classboard_open', { p_session: this.sid });
      if (this.dead || error || !data) return;
      this.info = { ...this.info, ...data }; this.gen = data.generation || 1; this.rev = Number(data.rev) || 0;
      this.status = 'ok'; this.resetScene(data.elements || []); this.updateUi();
      if (why === 'restore') toast(tr('A previous version of the board was restored.'), 'ok', 4500);
    }

    // ── pull ──
    schedulePull(ms) { clearTimeout(this.timers.pull); if (!this.dead) this.timers.pull = setTimeout(() => this.pull(), ms); }
    nextPollMs() { return document.hidden ? POLL_HIDDEN_MS : (this.rt ? POLL_RT_MS : POLL_MS); }
    async pull() {
      if (this.dead) return;
      if (this.pulling) { this.pullAgain = true; return; }
      if (!this.api) { this.schedulePull(200); return; }
      this.pulling = true;
      const { data, error } = await rpc('classboard_pull', { p_session: this.sid, p_since: this.rev, p_generation: this.gen, p_client: this.cid,
        p_presence: this.participant ? { pointer: this.pointer } : null });
      this.pulling = false;
      if (this.dead) return;
      if (error || !data) {
        if (/No autorizado/.test(error?.message || '')) { this.destroy(true); this.fail(tr("You don't have access to this board.")); return; }
        this.status = 'offline'; this.renderStatus(); this.schedulePull(5000); return;
      }
      if (this.status === 'offline' || this.status === 'loading') this.status = 'ok';
      const lockChanged = !!data.locked !== !!this.info.locked || !!data.can_edit !== !!this.info.can_edit;
      this.info.bytes = data.bytes;
      if ((data.generation || 1) !== this.gen) {
        this.gen = data.generation || 1; this.rev = Number(data.rev) || 0;
        this.info.locked = !!data.locked; this.info.can_edit = !!data.can_edit;
        this.resetScene(data.elements || []); this.updateUi();
        toast(tr('A previous version of the board was restored.'), 'ok', 4500);
      } else {
        if (lockChanged && !data.can_edit && this.pending.size) this.pending.clear();
        this.info.locked = !!data.locked; this.info.can_edit = !!data.can_edit;
        this.applyRemote(data.elements || []);
        (data.elements || []).forEach(e => { const b = this.bcAt.get(e?.id); if (b && e.version >= b.v) this.bcAt.delete(e.id); });
        this.rev = Math.max(this.rev, Number(data.rev) || 0);
        if (this.bcAt.size) this.truthCheck();
        if (lockChanged) { this.updateUi(); if (this.info.role === 'student') toast(tr(data.locked ? 'The teacher locked the board.' : 'The teacher unlocked the board: you can draw again.'), 'ok', 4000); }
        else if (this.lastBytesNotice !== (Number(data.bytes) > 0.8 * 2097152)) { this.lastBytesNotice = Number(data.bytes) > 0.8 * 2097152; this.updateUi(); }
      }
      this.applyPresence(data.presence || []);
      this.renderStatus();
      if (this.pullAgain) { this.pullAgain = false; this.schedulePull(30); } else this.schedulePull(this.nextPollMs());
    }

    // ── presence + pointers (names and colours from the database) ──
    applyPresence(list) {
      const keep = new Set();
      list.forEach(p => {
        const id = String(p.client || ''); if (!id || id === this.cid) return;
        keep.add(id);
        const prev = this.remote.get(id) || {};
        const ptr = this.rt ? prev.pointer : (p.state && p.state.pointer && Number.isFinite(p.state.pointer.x) && Number.isFinite(p.state.pointer.y) ? { x: p.state.pointer.x, y: p.state.pointer.y, tool: 'pointer' } : null);
        this.remote.set(id, { name: String(p.name || ''), color: safeColor(p.color), role: p.role, pointer: ptr || prev.pointer || null, button: prev.button || 'up' });
      });
      [...this.remote.keys()].forEach(id => { if (!keep.has(id)) this.remote.delete(id); });
      this.renderPeople(); this.applyCollaborators();
    }
    applyCollaborators() {
      if (!this.api || this.dead || this.collabRaf) return;
      this.collabRaf = requestAnimationFrame(() => {
        this.collabRaf = 0; if (!this.api || this.dead) return;
        const m = new Map();
        this.remote.forEach((p, id) => m.set(id, { id, username: p.name, color: { background: p.color, stroke: p.color }, pointer: p.pointer || undefined, button: p.button || 'up' }));
        this.api.updateScene({ collaborators: m });
      });
    }
    onPointer(p) {
      if (!this.participant || !p || !p.pointer) return;
      this.pointer = { x: Math.round(p.pointer.x), y: Math.round(p.pointer.y) };
      if (!this.channel || !this.rt) return;
      const now = Date.now();
      const sendIt = () => { this.lastPtr = Date.now(); this.send('ptr', { c: this.cid, x: this.pointer.x, y: this.pointer.y, t: p.pointer.tool === 'laser' ? 'laser' : 'pointer', b: p.button === 'down' ? 'down' : 'up' }); };
      clearTimeout(this.timers.ptr);
      if (!this.lastPtr || now - this.lastPtr >= PTR_MS) sendIt(); else this.timers.ptr = setTimeout(sendIt, PTR_MS);
    }
    remotePointer(m) {
      const id = String(m?.c || ''); if (!id || id === this.cid) return;
      const rec = this.remote.get(id);
      if (!rec) { this.schedulePull(80); return; } // a new person: their name comes from the database
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      rec.pointer = { x: m.x, y: m.y, tool: m.t === 'laser' ? 'laser' : 'pointer' }; rec.button = m.b === 'down' ? 'down' : 'up';
      this.applyCollaborators();
    }
    remoteElements(m) {
      if (!m || m.c === this.cid || m.g !== this.gen || !Array.isArray(m.e) || m.e.length > 2000) return;
      const now = Date.now();
      m.e.forEach(e => { if (validEl(e)) { const b = this.bcAt.get(e.id); if (!b || e.version > b.v) this.bcAt.set(e.id, { t: b ? b.t : now, v: e.version }); } });
      this.applyRemote(m.e);
    }
    // The screen converges to what the database stored: an element drawn from a broadcast that no pull confirmed within a few
    // seconds (its author could not save it — board locked, full, refused, or a forged message) is replaced by the stored
    // version, or removed if the database never got it.
    async truthCheck() {
      const now = Date.now(); const stale = [...this.bcAt.entries()].filter(([, b]) => now - b.t > 6000).map(([id]) => id);
      if (!stale.length || this.truthBusy || (this.lastTruth && now - this.lastTruth < 10000)) return;
      this.truthBusy = true; this.lastTruth = now;
      const { data, error } = await rpc('classboard_pull', { p_session: this.sid, p_since: 0, p_generation: this.gen, p_client: this.cid, p_presence: null });
      this.truthBusy = false;
      if (this.dead || error || !data || !this.api || (data.generation || 1) !== this.gen) return;
      const server = new Map((data.elements || []).filter(validEl).map(e => [e.id, e]));
      const M = this.M; let changed = false;
      const els = this.api.getSceneElementsIncludingDeleted().flatMap(el => {
        if (!stale.includes(el.id) || this.pending.has(el.id) || this.known.get(el.id) !== el.version) return [el];
        const S = server.get(el.id);
        if (!S) { changed = true; this.known.delete(el.id); return []; }
        if (S.version === el.version && S.versionNonce === el.versionNonce) return [el];
        changed = true; const r = M.restoreElements([S], null)[0]; this.known.set(r.id, r.version); return [r];
      });
      stale.forEach(id => this.bcAt.delete(id));
      if (changed) { this.api.updateScene({ elements: els, captureUpdate: M.CaptureUpdateAction.NEVER }); this.lastSceneVersion = M.getSceneVersion(els); }
    }

    // ── Realtime: private channel → public fallback (unguessable name; pokes + pointers only) → polling ──
    connectRealtime() {
      if (typeof sb === 'undefined' || typeof sb.channel !== 'function') return;
      const tryJoin = (topic, priv) => new Promise(resolve => {
        let done = false; const ch = sb.channel(topic, { config: { private: priv, broadcast: { self: false, ack: false } } });
        ch.on('broadcast', { event: 'els' }, m => { if (priv) this.remoteElements(m?.payload); });
        ch.on('broadcast', { event: 'poke' }, () => this.schedulePull(120));
        ch.on('broadcast', { event: 'lock' }, () => this.schedulePull(20));
        ch.on('broadcast', { event: 'hello' }, () => this.schedulePull(60));
        ch.on('broadcast', { event: 'ptr' }, m => this.remotePointer(m?.payload));
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
        if (!ch && key && !this.dead) { ch = await tryJoin('classboard-' + key, false); kind = 'public'; }
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

    // ── actions ──
    click(e) {
      const el = e.target.closest('[data-cb]');
      if (!el || !this.host.contains(el)) {
        const menu = this.host.querySelector('.cd-menu'); if (menu && !menu.hidden && !e.target.closest('.cd-menu-wrap')) this.toggleMenu(false);
        return;
      }
      const a = el.dataset.cb;
      if (a !== 'export-menu') this.toggleMenu(false);
      switch (a) {
        case 'lock': this.toggleLock(el); break;
        case 'history': this.historyDialog(); break;
        case 'ver-open': this.previewVersion(el.dataset.id); break;
        case 'ver-restore': this.restoreVersion(el.dataset.id, el); break;
        case 'ver-save': this.saveVersion(el); break;
        case 'sheet-close': this.closeSheet(); break;
        case 'export-menu': this.toggleMenu(); break;
        case 'png': this.exportPng(); break;
        case 'svg': this.exportSvg(); break;
        case 'page-prev': case 'page-next': { const l = this.pages?.pages || []; const i = l.findIndex(p => p.session_id === this.sid); const j = i + (a === 'page-next' ? 1 : -1); if (l[j]) this.goPage(l[j].session_id); break; }
        case 'page-today': this.goPage(this.pages?.today_session); break;
        case 'expand': this.full = !this.full; if (this.opts.onExpand) this.opts.onExpand(this.full); this.updateUi(); break;
        case 'close': if (this.opts.onClose) this.opts.onClose(); break;
      }
    }
    toggleMenu(force) {
      const m = this.host.querySelector('.cd-menu'); const b = this.host.querySelector('[data-cb="export-menu"]'); if (!m) return;
      const open = force === undefined ? m.hidden : !!force; m.hidden = !open; if (b) b.setAttribute('aria-expanded', String(open));
    }
    async toggleLock(btn) {
      if (!this.isTeacher || (typeof vaBlocked === 'function' && vaBlocked())) return;
      btn.disabled = true;
      const { data, error } = await rpc('classboard_set_lock', { p_session: this.sid, p_locked: !this.info.locked });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      this.info.locked = !!data?.locked; this.updateUi(); this.send('lock', { g: this.gen });
      toast(tr(this.info.locked ? 'Locked: students can look but not draw.' : 'Unlocked: students can draw again.'), 'ok');
    }
    sheet(html) {
      const s = this.host.querySelector('.cd-sheet'); if (!s) return null;
      s.innerHTML = `<div class="cd-sheet-box" role="dialog" aria-modal="true">${html}</div>`; s.hidden = false;
      setTimeout(() => s.querySelector('button,input,select')?.focus(), 30);
      return s;
    }
    closeSheet() { const s = this.host.querySelector('.cd-sheet'); if (s) { s.hidden = true; s.innerHTML = ''; } }

    // ── history: versions, preview (static SVG), restore (teacher) ──
    async historyDialog() {
      const head = `<div class="cd-sheet-h"><b>🕘 <span>History</span></b><button type="button" class="cd-x" data-cb="sheet-close" aria-label="${H(tr('Close'))}">✕</button></div>`;
      const s = this.sheet(head + `<div class="cd-loading">${H(tr('Loading…'))}</div>`);
      const { data, error } = await rpc('classboard_versions', { p_session: this.sid });
      if (!s || s.hidden) return;
      const box = s.querySelector('.cd-sheet-box');
      if (error) { box.querySelector('.cd-loading').textContent = tr('Could not load the history.'); return; }
      const L = { auto: 'Automatic', class_end: 'End of class', manual: 'Saved by the teacher', before_restore: 'Before a restore' };
      const items = (data || []).map(v => `<li class="cd-ver"><button type="button" class="cd-ver-open" data-cb="ver-open" data-id="${H(v.id)}"><b>${H(tr(L[v.label] || v.label))}</b>
        <span class="cd-pick-meta" data-no-i18n>${H(fDT(v.created_at))}${v.by ? ' · ' + H(v.by) : ''}${v.count != null ? ' · ' + H(String(v.count)) + ' ' + H(tr(v.count === 1 ? 'drawing' : 'drawings')) : ''}</span></button></li>`).join('');
      box.innerHTML = head + `<p class="cd-sheet-sub">${H(tr(this.isTeacher ? 'Versions are saved every 10 minutes while people draw, at the end of the class and when you save one. Open one to see it; you can restore it.' : 'Versions are saved every 10 minutes while people draw and at the end of the class. Only the teacher can restore one.'))}</p>
        ${this.isTeacher ? `<div class="gc-btn-row"><button type="button" class="tree-btn" data-cb="ver-save">💾 <span>Save a version now</span></button></div>` : ''}
        ${items ? `<ul class="cd-ver-list">${items}</ul>` : `<div class="cd-empty">${H(tr('No versions yet.'))}</div>`}
        <div class="cd-preview-wrap" hidden><div class="cd-preview-h"><b class="cd-preview-title" data-no-i18n></b> ${this.isTeacher ? `<button type="button" class="tree-btn danger" data-cb="ver-restore">↩ <span>Restore this version</span></button>` : ''}</div><div class="cd-preview cb-preview" data-no-i18n></div></div>`;
    }
    async previewVersion(id) {
      const s = this.host.querySelector('.cd-sheet'); if (!s) return;
      const { data, error } = await rpc('classboard_version', { p_version: id });
      if (error || !data) { toast('Error: ' + (error?.message || ''), 'err'); return; }
      const wrap = s.querySelector('.cd-preview-wrap'); const pv = s.querySelector('.cd-preview'); if (!wrap || !pv) return;
      pv.innerHTML = `<div class="cd-loading">${H(tr('Loading…'))}</div>`;
      try {
        const els = this.M.restoreElements((data.elements || []).filter(validEl), null);
        const svg = await this.M.exportToSvg({ elements: els, appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false }, files: null, exportPadding: 12, skipInliningFonts: true });
        svg.removeAttribute('width'); svg.removeAttribute('height'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', tr('Preview of this version'));
        pv.innerHTML = ''; pv.appendChild(svg);
      } catch (e) { pv.innerHTML = `<div class="cd-empty">${H(tr('Could not show this version.'))}</div>`; }
      const L = { auto: 'Automatic', class_end: 'End of class', manual: 'Saved by the teacher', before_restore: 'Before a restore' };
      wrap.querySelector('.cd-preview-title').textContent = `${tr(L[data.label] || data.label)} · ${fDT(data.created_at)}`;
      const rb = wrap.querySelector('[data-cb="ver-restore"]'); if (rb) rb.dataset.id = id;
      wrap.hidden = false; s.querySelectorAll('.cd-ver-open').forEach(b => b.classList.toggle('on', b.dataset.id === id));
      wrap.scrollIntoView({ block: 'nearest' });
    }
    async restoreVersion(id, btn) {
      if (!this.isTeacher || !id || (typeof vaBlocked === 'function' && vaBlocked())) return;
      if (!btn.classList.contains('confirm')) { btn.classList.add('confirm'); btn.innerHTML = `<span>${H(tr('Click again: everyone sees this version'))}</span>`; setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.innerHTML = `↩ <span>${H(tr('Restore this version'))}</span>`; } }, 4000); return; }
      btn.disabled = true;
      await this.flush();
      const { error } = await rpc('classboard_restore', { p_version: id });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      this.closeSheet(); this.send('poke', { g: this.gen });
      await this.reload();
      this.send('poke', { g: this.gen });
      toast(tr('Version restored ✓'), 'ok');
    }
    async saveVersion(btn) {
      if (!this.isTeacher) return;
      btn.disabled = true; await this.flush();
      const { data, error } = await rpc('classboard_add_version', { p_session: this.sid, p_label: 'manual' });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      toast(tr(data?.created ? 'Version saved ✓' : 'The board is empty: nothing to save yet.'), data?.created ? 'ok' : 'err');
      if (data?.created) this.historyDialog();
    }

    // ── export (Excalidraw's own exporters) ──
    exportArgs() {
      const st = this.api.getAppState();
      return { elements: this.api.getSceneElements(), files: this.api.getFiles(), exportPadding: 16,
        appState: { exportBackground: true, viewBackgroundColor: st.viewBackgroundColor || '#ffffff', exportWithDarkMode: false, exportScale: 2 } };
    }
    async exportPng() {
      if (!this.api) return;
      if (!this.api.getSceneElements().length) { toast(tr('The board is empty: nothing to export yet.'), 'err'); return; }
      try { const blob = await this.M.exportToBlob({ ...this.exportArgs(), mimeType: 'image/png' }); download(fileBase(this.info) + '.png', blob); }
      catch (e) { console.warn('png export', e); toast(tr('Could not export the board.'), 'err'); }
    }
    async exportSvg() {
      if (!this.api) return;
      if (!this.api.getSceneElements().length) { toast(tr('The board is empty: nothing to export yet.'), 'err'); return; }
      try {
        const a = this.exportArgs(); a.appState.exportScale = 1;
        const svg = await this.M.exportToSvg(a);
        download(fileBase(this.info) + '.svg', new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }));
      } catch (e) { console.warn('svg export', e); toast(tr('Could not export the board.'), 'err'); }
    }

    async close() {
      try { if (this.api) this.collectLocal(this.api.getSceneElementsIncludingDeleted()); await Promise.race([this.flush(), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* ignore */ }
      this.destroy();
    }
    destroy(keepDom) {
      if (this.dead) return; this.dead = true;
      Object.values(this.timers).forEach(t => clearTimeout(t));
      if (this.collabRaf) cancelAnimationFrame(this.collabRaf);
      document.removeEventListener('visibilitychange', this.onVis);
      this.host.removeEventListener('click', this.onClick);
      if (this.onPageSel) this.host.removeEventListener('change', this.onPageSel);
      if (this.channel) { try { sb.removeChannel(this.channel); } catch (e) { /* ignore */ } this.channel = null; }
      const root = this.root; this.root = null; this.api = null;
      if (root) { try { root.unmount(); } catch (e) { /* ignore */ } }
      if (!keepDom) this.host.innerHTML = '';
    }
  }

  // ── group board: another page = another class's board in the same place (overlay or side panel) ──
  async function swapPage(view, sid) {
    const host = view.host; const opts = { ...view.opts, pagesData: view.pages }; const full = view.full;
    await view.close();
    const v = new BoardView(host, sid, opts); v.full = full;
    if (overlay === view) overlay = v;
    host.__boardView = v;
    if (typeof opts.onSwap === 'function') opts.onSwap(v);
    await v.init();
    return v;
  }
  // the group board from a group card / the student dashboard: today's page, else the last class before today, else the first
  async function openGroup(groupId) {
    const { data, error } = await rpc('groupboard_pages', { p_group: groupId });
    if (error || !data) { toast(error ? 'Error: ' + error.message : tr('Could not open the board.'), 'err'); return null; }
    const list = data.pages || [];
    if (!list.length) { toast(tr('This group has no classes this school year yet.'), 'err', 5000); return null; }
    const pick = data.today_session || (list.filter(p => String(p.day) <= String(data.today)).pop() || list[0]).session_id;
    return open(pick, { pagesData: data });
  }

  // ── full-screen overlay ──
  let overlay = null;
  async function open(sessionId, opts = {}) {
    if (!sessionId) return null;
    if (overlay) await closeOverlay();
    let el = document.getElementById('cb-overlay');
    if (!el) { el = document.createElement('div'); el.id = 'cb-overlay'; el.className = 'cd-overlay cb-overlay'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', tr('Class board')); document.body.appendChild(el); }
    el.innerHTML = '<div class="cd-overlay-box"></div>'; el.classList.add('active'); document.body.classList.add('cd-open');
    const view = new BoardView(el.firstChild, sessionId, { ...opts, onClose: () => closeOverlay() });
    overlay = view;
    await view.init();
    return view;
  }
  async function closeOverlay() {
    const v = overlay; overlay = null; if (v) await v.close();
    const el = document.getElementById('cb-overlay'); if (el) { el.classList.remove('active'); el.innerHTML = ''; }
    if (!document.querySelector('#cd-overlay.active')) document.body.classList.remove('cd-open');
  }
  // embedded (live-class side panel); opts.onExpand(full) → the room shows the board over the whole stage
  async function mount(host, sessionId, opts = {}) { const v = new BoardView(host, sessionId, { ...opts, compact: true }); host.__boardView = v; await v.init(); return v; }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !overlay || !document.getElementById('cb-overlay')?.classList.contains('active')) return;
    const sh = document.querySelector('#cb-overlay .cd-sheet:not([hidden])');
    if (sh) overlay.closeSheet(); else if (!e.target.closest?.('.excalidraw')) closeOverlay();
  });
  window.addEventListener('pagehide', () => { if (overlay) { try { if (overlay.api) overlay.collectLocal(overlay.api.getSceneElementsIncludingDeleted()); } catch (e) { /* ignore */ } overlay.flush(); } });

  window.TCClassBoard = { open, openGroup, close: closeOverlay, mount, loadLib, _test: { validEl, get view() { return overlay; } } };

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // SPANISH (rioplatense "vos")
  // ════════════════════════════════════════════════════════════════════════════════════════════
  if (typeof DB_ERRORS !== 'undefined') DB_ERRORS.unshift(
    [/El docente bloqueó la pizarra/, 'The teacher locked the board.'], [/Solo lectura: no podés dibujar en esta pizarra/, 'Read-only: you cannot draw on this board.'],
    [/Pizarra desactualizada: volvé a abrirla/, 'The board changed: open it again.'],
    [/La pizarra llegó a su tamaño máximo.*$/, 'The board reached its maximum size (2 MB): delete drawings you no longer need to keep drawing.'],
    [/Las imágenes no están disponibles en la pizarra/, 'Images are not available on the board yet.'], [/Elemento no permitido en la pizarra/, 'That element is not allowed on the board.']
  );
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'Class board': 'Pizarra de la clase', 'Board': 'Pizarra', 'Group board': 'Pizarra del grupo', 'Board pages': 'Páginas de la pizarra', 'Page': 'Página',
    'Previous page': 'Página anterior', 'Next page': 'Página siguiente', 'Class': 'Clase', 'Today': 'Hoy', 'blank': 'en blanco',
    'This group has no classes this school year yet.': 'Este grupo todavía no tiene clases este año lectivo.', 'Opening the board…': 'Abriendo la pizarra…',
    'Class boards': 'Pizarras de tus clases', 'Open board': 'Abrir pizarra', 'See board': 'Ver pizarra',
    'Read-only: you can see what the class drew.': 'Solo lectura: podés ver lo que dibujó la clase.',
    'Everyone in the class can draw on it at the same time; it stays as a record.': 'Todos en la clase pueden dibujar a la vez; queda como registro.',
    'Could not load the board. Check your connection and try again.': 'No se pudo cargar la pizarra. Revisá tu conexión y probá de nuevo.',
    "You don't have access to this board.": 'No tenés acceso a esta pizarra.', 'Could not open the board.': 'No se pudo abrir la pizarra.',
    'People on the board': 'Personas en la pizarra', 'Download PNG': 'Descargar PNG', 'Download SVG': 'Descargar SVG',
    'Full screen': 'Pantalla completa', 'Exit full screen': 'Salir de pantalla completa',
    'Read-only: institution admins can see the board but not draw on it.': 'Solo lectura: los admins de la institución pueden ver la pizarra pero no dibujar.',
    'The teacher locked the board: you can look but not draw.': 'El docente bloqueó la pizarra: podés mirarla pero no dibujar.',
    'Locked for students: only you (and the substitute) can draw.': 'Bloqueada para estudiantes: solo vos (y el suplente) pueden dibujar.',
    'The board is full (2 MB): delete drawings you no longer need to keep drawing.': 'La pizarra está llena (2 MB): borrá dibujos que ya no uses para seguir dibujando.',
    'The board is almost full': 'La pizarra está casi llena', 'Board full: not saved': 'Pizarra llena: no se guardó',
    'Images are not available on the board yet.': 'Por ahora no se pueden poner imágenes en la pizarra.',
    'The teacher locked the board: your last change was not saved.': 'El docente bloqueó la pizarra: tu último cambio no se guardó.',
    'A previous version of the board was restored.': 'Se restauró una versión anterior de la pizarra.',
    'The teacher locked the board.': 'El docente bloqueó la pizarra.', 'The teacher unlocked the board: you can draw again.': 'El docente desbloqueó la pizarra: podés dibujar de nuevo.',
    'Locked: students can look but not draw.': 'Bloqueada: los estudiantes pueden mirar pero no dibujar.', 'Unlocked: students can draw again.': 'Desbloqueada: los estudiantes pueden dibujar de nuevo.',
    'drawing': 'dibujo', 'drawings': 'dibujos',
    'Versions are saved every 10 minutes while people draw, at the end of the class and when you save one. Open one to see it; you can restore it.': 'Las versiones se guardan cada 10 minutos mientras se dibuja, al terminar la clase y cuando guardás una. Abrí una para verla; podés restaurarla.',
    'Versions are saved every 10 minutes while people draw and at the end of the class. Only the teacher can restore one.': 'Las versiones se guardan cada 10 minutos mientras se dibuja y al terminar la clase. Solo el docente puede restaurar una.',
    'Preview of this version': 'Vista previa de esta versión', 'Could not show this version.': 'No se pudo mostrar esta versión.',
    'The board is empty: nothing to save yet.': 'La pizarra está vacía: todavía no hay nada para guardar.',
    'The board is empty: nothing to export yet.': 'La pizarra está vacía: todavía no hay nada para exportar.', 'Could not export the board.': 'No se pudo exportar la pizarra.',
    'Read-only: you cannot draw on this board.': 'Solo lectura: no podés dibujar en esta pizarra.', 'The board changed: open it again.': 'La pizarra cambió: volvé a abrirla.',
    'The board reached its maximum size (2 MB): delete drawings you no longer need to keep drawing.': 'La pizarra llegó a su tamaño máximo (2 MB): borrá dibujos que ya no uses para seguir dibujando.',
    'That element is not allowed on the board.': 'Ese elemento no está permitido en la pizarra.',
    // shared with the class document (same words; defined here too so the board works on its own)
    'History': 'Historial', 'Export': 'Exportar', 'Close': 'Cerrar', 'Loading…': 'Cargando…', 'Unlock for students': 'Desbloquear para estudiantes', 'Lock for students': 'Bloquear para estudiantes',
    'View as is read-only.': '"Ver como" es solo lectura.', 'Connection problem: retrying…': 'Problema de conexión: reintentando…', 'Saving…': 'Guardando…', '● Live': '● En vivo',
    'Live sync unavailable: updates every few seconds': 'Sincronización en vivo no disponible: se actualiza cada pocos segundos',
    'Updates every few seconds': 'Se actualiza cada pocos segundos', 'Read-only': 'Solo lectura', 'All changes saved': 'Todos los cambios guardados',
    'you': 'vos', 'person here': 'persona acá', 'people here': 'personas acá', 'Could not load the history.': 'No se pudo cargar el historial.',
    'Automatic': 'Automática', 'End of class': 'Fin de la clase', 'Saved by the teacher': 'Guardada por el docente', 'Before a restore': 'Antes de restaurar',
    'Save a version now': 'Guardar una versión ahora', 'No versions yet.': 'Todavía no hay versiones.', 'Restore this version': 'Restaurar esta versión',
    'Click again: everyone sees this version': 'Hacé clic de nuevo: todos van a ver esta versión', 'Version restored ✓': 'Versión restaurada ✓', 'Version saved ✓': 'Versión guardada ✓',
    'Too many changes in a row: wait a moment.': 'Demasiados cambios seguidos: esperá un momento.', 'Invalid change.': 'Cambio inválido.', 'That change is too big.': 'Ese cambio es demasiado grande.',
  });
})();
