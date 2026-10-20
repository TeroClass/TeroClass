/* TeroClass · Class document ("Documento de la clase"): one shared document per calendar class
 * ------------------------------------------------------------------------------------------
 * Everyone in the class (teacher, substitute, enrolled / invited students) reads and types at the same time; the
 * teacher can lock it (students read only), paste one of their saved classes (STUDENT HANDOUT version, never the
 * answers) and restore a previous version. Institution admins of the unit and the super admin: read-only.
 * It stays as a record after the class.
 *
 * Editor: TipTap 2 (ProseMirror) + Yjs, vendored as ONE pinned ES module (public/vendor/classdoc-editor.js, loaded on
 * demand with import(); rebuilt only by scripts/vendor/build-classdoc.sh). No build step for the app.
 * Sync (all access checked in the database: supabase/migrations/001_base.sql, "DOCUMENTO DE LA CLASE"):
 *   · every local change → classdoc_push (Yjs update, base64); changes are read with classdoc_pull (ordered ids);
 *   · Supabase Realtime PRIVATE channel "classdoc:<session id>" (policies on realtime.messages) only carries
 *     "there are changes, pull" pokes and cursor positions — never document content. Fallback: a public channel with
 *     an unguessable name returned by classdoc_open (same no-content rule); without Realtime: pull every 2 s.
 *   · an editor sends a compact snapshot now and then (classdoc_snapshot); versions + restore in "History".
 * Names / colours of the people in the document come from the database (never from other browsers).
 * Depends on globals from index.html: sb, currentUser, viewAs, esc, showToast, trText, uiLang, uiLocale, I18N_ES,
 * I18N_RULES_ES, DB_ERRORS, plannings, loadPlannings, formatDoc, cleanStudentHandout, vaBlocked.
 */
(function () {
  'use strict';

  const EDITOR_URL = '/vendor/classdoc-editor.js';
  const REMOTE = 'tc-remote';
  const POLL_MS = 2000, POLL_RT_MS = 15000, POLL_HIDDEN_MS = 8000;
  const SNAP_EVERY = 40, SNAP_IDLE_MS = 30000;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const toast = (m, t, ms) => { if (typeof showToast === 'function') showToast(m, t, ms); };
  const inViewAs = () => typeof viewAs !== 'undefined' && !!viewAs;
  const H = s => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const loc = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  const fDT = d => { try { return new Date(d).toLocaleString(loc(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(typeof uiLang !== 'undefined' && uiLang === 'es' ? { hourCycle: 'h23' } : {}) }); } catch (e) { return ''; } };
  const initials = n => (String(n || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
  const safeColor = c => (COLOR_RE.test(String(c || '')) ? c : '#7c5cbf');

  let modP = null;
  const loadEditor = () => (modP = modP || import(EDITOR_URL).catch(e => { modP = null; throw e; }));

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
  const fileBase = info => (String(info?.session?.title || 'clase').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'clase')
    + '-' + String(info?.session?.starts_at || '').slice(0, 10);

  // ── text of a saved class (student handout) → HTML for the editor ──
  // Uses the app's own formatter (formatDoc: titles, section heads, bullets; every line escaped) and maps it to
  // semantic tags; consecutive bullets become one list. Markdown tables ("| a | b |") become tables.
  function handoutToHtml(text, title) {
    const out = [title ? `<h2>${H(title)}</h2>` : ''];
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const chunks = []; let buf = [];
    const flush = () => { if (buf.length) chunks.push({ text: buf.join('\n') }); buf = []; };
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\|.*\|\s*$/.test(lines[i])) { flush(); const rows = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; } i--; chunks.push({ table: rows }); }
      else buf.push(lines[i]);
    }
    flush();
    chunks.forEach((c, ci) => {
      if (c.table) {
        const rows = c.table.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim()));
        if (!rows.length) return;
        out.push('<table><tbody>' + rows.map((r, ri) => '<tr>' + r.map(x => ri === 0 ? `<th>${H(x)}</th>` : `<td>${H(x)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        return;
      }
      const html = typeof formatDoc === 'function' ? formatDoc((ci === 0 && title ? '\n' : '') + c.text) : c.text.split('\n').map(l => `<div class="cls-line">${H(l)}</div>`).join('');
      const tpl = document.createElement('template'); tpl.innerHTML = html;
      let list = null;
      const endList = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
      [...tpl.content.children].forEach(el => {
        const txt = (el.textContent || '').trim();
        if (el.classList.contains('cls-bullet')) { (list = list || []).push(`<li><p>${H(txt)}</p></li>`); return; }
        endList();
        if (!txt) return;
        if (el.classList.contains('cls-title')) out.push(`<h2>${H(txt)}</h2>`);
        else if (el.classList.contains('cls-section-head')) out.push(`<h3>${H(txt)}</h3>`);
        else if (el.classList.contains('cls-challenge')) out.push(`<p><strong>${H(txt)}</strong></p>`);
        else if (/^\d+[.)]\s+/.test(txt)) out.push(`<p>${H(txt)}</p>`);
        else out.push(`<p>${H(txt)}</p>`);
      });
      endList();
    });
    return out.join('');
  }

  // ── ProseMirror JSON → Markdown (download) ──
  function toMarkdown(doc) {
    const inline = nodes => (nodes || []).map(n => {
      if (n.type === 'hardBreak') return '  \n';
      if (n.type !== 'text') return '';
      let t = String(n.text || '').replace(/([*_`\\[\]])/g, '\\$1');
      (n.marks || []).forEach(m => {
        if (m.type === 'bold') t = `**${t}**`; else if (m.type === 'italic') t = `_${t}_`; else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'code') t = '`' + t + '`'; else if (m.type === 'link' && /^(https?:|mailto:)/i.test(m.attrs?.href || '')) t = `[${t}](${m.attrs.href})`;
      });
      return t;
    }).join('');
    const cellText = c => (c.content || []).map(p => inline(p.content)).join(' ').replace(/\|/g, '\\|');
    const block = (n, depth = 0) => {
      const pad = '  '.repeat(depth);
      switch (n.type) {
        case 'heading': return '#'.repeat(Math.min(6, n.attrs?.level || 1)) + ' ' + inline(n.content) + '\n';
        case 'paragraph': return pad + inline(n.content) + '\n';
        case 'bulletList': return (n.content || []).map(li => listItem(li, '- ', depth)).join('');
        case 'orderedList': return (n.content || []).map((li, i) => listItem(li, `${(n.attrs?.start || 1) + i}. `, depth)).join('');
        case 'blockquote': return (n.content || []).map(c => '> ' + block(c)).join('');
        case 'codeBlock': return '```\n' + (n.content || []).map(t => t.text || '').join('') + '\n```\n';
        case 'horizontalRule': return '---\n';
        case 'table': {
          const rows = (n.content || []).map(r => (r.content || []).map(cellText));
          if (!rows.length) return '';
          const w = Math.max(...rows.map(r => r.length));
          const line = r => '| ' + Array.from({ length: w }, (_, i) => r[i] || '').join(' | ') + ' |';
          return [line(rows[0]), '| ' + Array(w).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n') + '\n';
        }
        default: return (n.content || []).map(c => block(c, depth)).join('');
      }
    };
    const listItem = (li, bullet, depth) => {
      const pad = '  '.repeat(depth); const parts = li.content || [];
      return parts.map((c, i) => (i === 0 && c.type === 'paragraph' ? pad + bullet + inline(c.content) + '\n' : block(c, depth + 1))).join('');
    };
    return (doc.content || []).map(n => block(n)).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // DocView: one open document (full-screen overlay or the live-class side panel)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  let seq = 0;
  class DocView {
    constructor(host, sessionId, opts = {}) {
      this.host = host; this.sid = sessionId; this.opts = opts; this.id = 'cd' + (++seq);
      this.pending = []; this.pushing = false; this.pulling = false; this.pullAgain = false; this.after = 0; this.gen = 1;
      this.rt = null; this.channel = null; this.timers = { pull: null, push: null, cur: null, snap: null };
      this.remote = new Map(); this.rtCursors = new Map(); this.sinceSnap = 0; this.lastSnap = Date.now(); this.dirtySnap = false;
      this.dead = false; this.status = 'loading'; this.lastErr = 0;
      this.onVis = () => this.schedulePull(50);
      this.onClick = e => this.click(e);
      this.onDown = e => { if (e.target.closest('.cd-tb')) e.preventDefault(); }; // the toolbar never steals the editor's focus
    }
    get canEdit() { return !!this.info?.can_edit && !inViewAs(); }
    get isTeacher() { return this.info?.role === 'teacher' && !inViewAs(); }
    get participant() { return (this.info?.role === 'teacher' || this.info?.role === 'student') && !inViewAs(); }

    async init() {
      this.host.innerHTML = `<div class="cd-shell${this.opts.compact ? ' compact' : ''}" id="${this.id}"><div class="cd-loading">${H(tr('Opening the class document…'))}</div></div>`;
      this.host.addEventListener('click', this.onClick);
      this.host.addEventListener('mousedown', this.onDown);
      let M, res;
      try { [M, res] = await Promise.all([loadEditor(), rpc('classdoc_open', { p_session: this.sid })]); }
      catch (e) { console.warn('classdoc editor', e); return this.fail(tr('Could not load the editor. Check your connection and try again.')); }
      if (this.dead) return;
      if (res.error || !res.data) return this.fail(/No autorizado/.test(res.error?.message || '') ? tr("You don't have access to this class document.") : tr('Could not open the class document.') + ' ' + (res.error?.message || ''));
      this.M = M; this.info = res.data;
      this.renderShell();
      this.buildDoc(res.data);
      this.createEditor();
      document.addEventListener('visibilitychange', this.onVis);
      this.connectRealtime();
      this.schedulePull(this.participant ? 300 : 1500);
      this.updateUi();
      return this;
    }
    fail(msg) {
      this.status = 'error';
      this.host.innerHTML = `<div class="cd-shell${this.opts.compact ? ' compact' : ''}"><div class="cd-fail" role="alert"><span aria-hidden="true">📄</span><p data-no-i18n>${H(msg)}</p>${this.opts.compact ? '' : `<button type="button" class="tree-btn" data-cd="close">${H(tr('Close'))}</button>`}</div></div>`;
      return null;
    }

    // ── Yjs document + editor ──
    buildDoc(p) {
      const { Y, Awareness } = this.M;
      this.ydoc = new Y.Doc();
      this.awareness = new Awareness(this.ydoc); // local state: only participants publish their cursor (see createEditor)
      this.gen = p.generation || 1;
      this.after = Math.max(Number(p.upto) || 0, 0);
      Y.transact(this.ydoc, () => {
        if (p.state) Y.applyUpdate(this.ydoc, fromB64(p.state), REMOTE);
        (p.updates || []).forEach(u => { Y.applyUpdate(this.ydoc, fromB64(u.d), REMOTE); this.after = Math.max(this.after, Number(u.id) || 0); });
      }, REMOTE);
      this.ydoc.on('update', (u, origin) => { if (origin !== REMOTE && !this.dead) { this.pending.push(u); this.schedulePush(); this.dirtySnap = true; } });
      this.awareness.on('change', (ch, origin) => { if (origin === 'local') this.localCursorChanged(); });
    }
    createEditor() {
      const M = this.M; const me = this.info.me || { name: tr('Reader'), color: '#888888' };
      const el = this.host.querySelector('.cd-editor');
      this.editor = new M.Editor({
        element: el, editable: this.canEdit,
        extensions: [
          M.StarterKit.configure({ history: false, heading: { levels: [1, 2, 3] } }),
          M.Link.configure({ openOnClick: false, autolink: true, protocols: ['mailto'], HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } }),
          M.Table.configure({ resizable: false }), M.TableRow, M.TableHeader, M.TableCell,
          M.Placeholder.configure({ placeholder: tr(this.canEdit ? 'Write here… Everyone in the class sees it as you type.' : 'This document is empty.') }),
          M.Collaboration.configure({ document: this.ydoc }),
          M.CollaborationCursor.configure({ provider: { awareness: this.awareness }, user: { name: me.name, color: safeColor(me.color) } }),
        ],
        editorProps: { attributes: { class: 'cd-prose', 'aria-label': tr('Class document'), spellcheck: 'true' } },
        onTransaction: () => this.updateToolbar(),
      });
      if (!this.participant) this.awareness.setLocalState(null);
    }
    rebuild(p, why) { // generation changed (version restored) or locked with unsent changes: start again from the server
      try { this.editor?.destroy(); } catch (e) { /* ignore */ }
      try { this.awareness?.destroy(); } catch (e) { /* ignore */ }
      try { this.ydoc?.destroy(); } catch (e) { /* ignore */ }
      this.pending = []; this.remote.clear(); this.sinceSnap = 0; this.dirtySnap = false;
      this.info = { ...this.info, generation: p.generation, locked: p.locked, can_edit: p.can_edit ?? this.info.can_edit };
      this.host.querySelector('.cd-editor').innerHTML = '';
      this.buildDoc(p); this.createEditor(); this.updateUi();
      if (why === 'restore') toast(tr('A previous version of the document was restored.'), 'ok', 4500);
    }

    // ── shell ──
    renderShell() {
      const i = this.info; const s = i.session || {}; const c = !!this.opts.compact;
      const tb = (k, label, ico, extra = '') => `<button type="button" class="cd-tb" data-cd="fmt" data-k="${k}" title="${H(tr(label))}" aria-label="${H(tr(label))}" ${extra}>${ico}</button>`;
      this.host.querySelector('.cd-shell').innerHTML = `
        <header class="cd-head">
          <div class="cd-head-main">
            ${c ? '' : `<div class="cd-kicker"><span aria-hidden="true">📄</span> <span>Class document</span></div>`}
            <div class="cd-title" data-no-i18n>${H(s.title || '')}</div>
            <div class="cd-meta"><span data-no-i18n>${H(s.group_name || '')}</span>${s.group_name ? ' · ' : ''}<span data-no-i18n>${H(fDT(s.starts_at))}</span></div>
          </div>
          <div class="cd-people" aria-label="${H(tr('People in the document'))}"></div>
          <div class="cd-status" role="status" aria-live="polite" data-no-i18n></div>
          <div class="cd-actions">
            <button type="button" class="tree-btn cd-lock" data-cd="lock" hidden></button>
            <button type="button" class="tree-btn" data-cd="paste" hidden>🎒 <span>Paste a class</span></button>
            <button type="button" class="tree-btn" data-cd="history">🕘 <span>History</span></button>
            <div class="cd-menu-wrap"><button type="button" class="tree-btn" data-cd="export-menu" aria-haspopup="true" aria-expanded="false">⬇ <span>Export</span></button>
              <div class="cd-menu" role="menu" hidden>
                <button type="button" role="menuitem" data-cd="print">🖨 <span>Print / PDF</span></button>
                <button type="button" role="menuitem" data-cd="dl-html">⬇ <span>Download HTML</span></button>
                <button type="button" role="menuitem" data-cd="dl-md">⬇ <span>Download Markdown</span></button>
              </div></div>
            ${c ? '' : `<button type="button" class="tree-btn cd-close" data-cd="close" aria-label="${H(tr('Close'))}">✕ <span>Close</span></button>`}
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
        <div class="cd-page cd-print-area"><div class="cd-print-head"><b data-no-i18n>${H(s.title || '')}</b> <span data-no-i18n>${H(s.group_name || '')} · ${H(fDT(s.starts_at))}</span></div><div class="cd-editor" data-no-i18n></div></div>
        <div class="cd-sheet" hidden></div>`;
    }
    updateUi() {
      const root = this.host.querySelector('.cd-shell'); if (!root || !this.info) return;
      const i = this.info;
      root.classList.toggle('readonly', !this.canEdit);
      const lock = root.querySelector('[data-cd="lock"]');
      if (lock) { lock.hidden = !this.isTeacher; lock.innerHTML = i.locked ? `🔓 <span>${H(tr('Unlock for students'))}</span>` : `🔒 <span>${H(tr('Lock for students'))}</span>`; lock.setAttribute('aria-pressed', String(!!i.locked)); }
      const paste = root.querySelector('[data-cd="paste"]'); if (paste) paste.hidden = !this.isTeacher;
      root.querySelector('.cd-toolbar').hidden = !this.canEdit;
      const n = root.querySelector('.cd-notice');
      let msg = '';
      if (inViewAs()) msg = tr('View as is read-only.');
      else if (i.role === 'admin') msg = tr('Read-only: institution admins can read the class document but not edit it.');
      else if (i.locked && i.role === 'student') msg = tr('The teacher locked the document: you can read it but not edit it.');
      else if (i.locked) msg = tr('Locked for students: only you (and the substitute) can edit.');
      if (n) { n.hidden = !msg; n.textContent = msg; n.className = 'cd-notice' + (i.locked ? ' locked' : ''); }
      if (this.editor && this.editor.isEditable !== this.canEdit) this.editor.setEditable(this.canEdit);
      this.renderStatus(); this.renderPeople(); this.updateToolbar();
    }
    renderStatus() {
      const el = this.host.querySelector('.cd-status'); if (!el) return;
      let cls = 'cd-status', txt;
      if (this.status === 'offline') { cls += ' err'; txt = tr('Connection problem: retrying…'); }
      else if (this.pending.length || this.pushing) { cls += ' saving'; txt = tr('Saving…'); }
      else if (this.rt) { cls += ' live'; txt = tr('● Live'); }
      else { cls += ' poll'; txt = tr('Live sync unavailable: updates every few seconds'); }
      if (!this.canEdit && this.status !== 'offline') txt = (this.rt ? tr('● Live') : tr('Updates every few seconds')) + ' · ' + tr('Read-only');
      el.className = cls; el.textContent = txt;
      if (!this.pending.length && !this.pushing && this.canEdit && this.status !== 'offline') el.title = tr('All changes saved');
    }
    renderPeople() {
      const el = this.host.querySelector('.cd-people'); if (!el) return;
      const seen = new Set(); const list = [];
      const me = this.participant && this.info.me ? [{ name: this.info.me.name, color: this.info.me.color, me: true }] : [];
      [...me, ...[...this.remote.values()]].forEach(p => { const k = p.name + '|' + p.color; if (seen.has(k)) return; seen.add(k); list.push(p); });
      if (!list.length) { el.innerHTML = ''; return; }
      el.innerHTML = list.slice(0, 8).map(p => `<span class="cd-av" style="background:${safeColor(p.color)}" title="${H(p.name)}${p.me ? ' (' + H(tr('you')) + ')' : ''}" data-no-i18n>${H(initials(p.name))}</span>`).join('')
        + (list.length > 8 ? `<span class="cd-av more" data-no-i18n>+${list.length - 8}</span>` : '')
        + `<span class="cd-people-n"><b>${list.length}</b> <span>${H(tr(list.length === 1 ? 'person here' : 'people here'))}</span></span>`;
    }
    updateToolbar() {
      const ed = this.editor; const tb = this.host.querySelector('.cd-toolbar'); if (!ed || !tb || tb.hidden) return;
      const act = { h1: ed.isActive('heading', { level: 1 }), h2: ed.isActive('heading', { level: 2 }), h3: ed.isActive('heading', { level: 3 }), p: ed.isActive('paragraph'),
        bold: ed.isActive('bold'), italic: ed.isActive('italic'), strike: ed.isActive('strike'), ul: ed.isActive('bulletList'), ol: ed.isActive('orderedList'), quote: ed.isActive('blockquote'), link: ed.isActive('link') };
      tb.querySelectorAll('[data-cd="fmt"]').forEach(b => { const on = !!act[b.dataset.k]; b.classList.toggle('on', on); if (b.dataset.k in act) b.setAttribute('aria-pressed', String(on)); });
      const tt = tb.querySelector('.cd-tbl-tools'); if (tt) tt.hidden = !ed.isActive('table');
    }

    // ── sync ──
    schedulePush() {
      this.renderStatus();
      clearTimeout(this.timers.push);
      this.timers.push = setTimeout(() => this.flush(), this.pending.length > 30 ? 60 : 250);
    }
    async flush() {
      if (this.dead || this.pushing || !this.pending.length) return;
      if (!this.canEdit) { this.pending = []; return; }
      const { Y } = this.M;
      const merged = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending);
      const batch = this.pending; this.pending = []; this.pushing = true; this.renderStatus();
      const { error } = await rpc('classdoc_push', { p_session: this.sid, p_generation: this.gen, p_update: toB64(merged), p_client: String(this.ydoc.clientID) });
      this.pushing = false;
      if (this.dead) return;
      if (error) {
        const m = error.message || '';
        if (/bloque/i.test(m)) { toast(tr('The teacher locked the document: your last change was not saved.'), 'err', 5000); this.info.locked = true; this.info.can_edit = false; this.forceReload(); return; }
        if (/desactualizado/i.test(m)) { this.forceReload(); return; }
        if (/Solo lectura|No autorizado/.test(m)) { this.info.can_edit = false; this.updateUi(); return; }
        this.pending = batch.concat(this.pending); this.status = 'offline'; this.renderStatus();
        clearTimeout(this.timers.push); this.timers.push = setTimeout(() => this.flush(), 3000); return;
      }
      if (this.status === 'offline') this.status = 'ok';
      this.sinceSnap++;
      this.poke('poke');
      this.renderStatus();
      if (this.pending.length) this.schedulePush(); else this.maybeSnapshot();
    }
    async forceReload() {
      const { data, error } = await rpc('classdoc_open', { p_session: this.sid });
      if (this.dead || error || !data) return;
      this.info = data; this.rebuild({ ...data, can_edit: data.can_edit });
    }
    schedulePull(ms) {
      clearTimeout(this.timers.pull);
      if (this.dead) return;
      this.timers.pull = setTimeout(() => this.pull(), ms);
    }
    nextPollMs() { return document.hidden ? POLL_HIDDEN_MS : (this.rt ? POLL_RT_MS : POLL_MS); }
    async pull() {
      if (this.dead) return;
      if (this.pulling) { this.pullAgain = true; return; }
      this.pulling = true;
      const cur = this.participant ? (this.awareness.getLocalState()?.cursor ?? null) : null;
      const { data, error } = await rpc('classdoc_pull', { p_session: this.sid, p_after: this.after, p_generation: this.gen, p_client: String(this.ydoc.clientID),
        p_presence: this.participant ? { cursor: cur } : null });
      this.pulling = false;
      if (this.dead) return;
      if (error || !data) {
        if (/No autorizado/.test(error?.message || '')) { this.fail(tr("You don't have access to this class document.")); this.destroy(true); return; }
        this.status = 'offline'; this.renderStatus(); this.schedulePull(5000); return;
      }
      if (this.status === 'offline') this.status = 'ok';
      const lockChanged = !!data.locked !== !!this.info.locked || !!data.can_edit !== !!this.info.can_edit;
      if ((data.generation || 1) !== this.gen) { this.rebuild(data, 'restore'); }
      else {
        const { Y } = this.M;
        if (lockChanged && !data.can_edit && this.pending.length) { this.info.locked = data.locked; this.info.can_edit = data.can_edit; this.forceReload(); }
        Y.transact(this.ydoc, () => {
          if (data.reset && data.state) Y.applyUpdate(this.ydoc, fromB64(data.state), REMOTE);
          (data.updates || []).forEach(u => { if (String(u.c) !== String(this.ydoc.clientID) || data.reset) Y.applyUpdate(this.ydoc, fromB64(u.d), REMOTE); this.after = Math.max(this.after, Number(u.id) || 0); if (String(u.c) !== String(this.ydoc.clientID)) this.sinceSnap++; });
          if (data.reset) this.after = Math.max(this.after, Number(data.upto) || 0);
        }, REMOTE);
        this.info.locked = !!data.locked; this.info.can_edit = !!data.can_edit;
        if (lockChanged) { this.updateUi(); if (this.info.role === 'student') toast(tr(data.locked ? 'The teacher locked the document.' : 'The teacher unlocked the document: you can edit again.'), 'ok', 4000); }
      }
      this.applyPresence(data.presence || []);
      if (this.pullAgain) { this.pullAgain = false; this.schedulePull(30); } else this.schedulePull(this.nextPollMs());
      this.maybeSnapshot();
    }
    async maybeSnapshot() {
      if (!this.canEdit || this.pending.length || this.pushing || this.snapping) return;
      const due = this.sinceSnap >= SNAP_EVERY || (this.dirtySnap && Date.now() - this.lastSnap > SNAP_IDLE_MS && this.sinceSnap > 0);
      if (!due) return;
      this.snapping = true;
      const state = toB64(this.M.Y.encodeStateAsUpdate(this.ydoc));
      const { data, error } = await rpc('classdoc_snapshot', { p_session: this.sid, p_generation: this.gen, p_state: state, p_upto: this.after });
      this.snapping = false;
      if (!error && data) { this.sinceSnap = 0; this.lastSnap = Date.now(); this.dirtySnap = false; }
    }

    // ── presence + cursors ──
    applyPresence(list) {
      const aw = this.awareness; const now = Date.now(); const keep = new Set();
      const changed = { added: [], updated: [], removed: [] };
      list.forEach(p => {
        const id = Number(p.client); if (!Number.isFinite(id) || id === this.ydoc.clientID) return;
        keep.add(id);
        const prev = this.remote.get(id);
        const rec = { name: String(p.name || ''), color: safeColor(p.color), role: p.role, cursor: this.rtCursors.has(id) ? this.rtCursors.get(id) : (p.state?.cursor ?? null) };
        this.remote.set(id, rec);
        aw.states.set(id, { user: { name: rec.name, color: rec.color }, cursor: rec.cursor });
        aw.meta.set(id, { clock: (aw.meta.get(id)?.clock || 0) + 1, lastUpdated: now });
        (prev ? changed.updated : changed.added).push(id);
      });
      [...this.remote.keys()].forEach(id => { if (!keep.has(id)) { this.remote.delete(id); this.rtCursors.delete(id); aw.states.delete(id); aw.meta.delete(id); changed.removed.push(id); } });
      if (changed.added.length || changed.updated.length || changed.removed.length) aw.emit('change', [changed, REMOTE]);
      this.renderPeople();
    }
    remoteCursor(msg) {
      const id = Number(msg?.c); if (!Number.isFinite(id) || id === this.ydoc?.clientID) return;
      const cur = msg.cur && typeof msg.cur === 'object' ? msg.cur : null;
      this.rtCursors.set(id, cur);
      const rec = this.remote.get(id);
      if (!rec) { this.schedulePull(80); return; } // a new person: their name comes from the database
      rec.cursor = cur;
      this.awareness.states.set(id, { user: { name: rec.name, color: rec.color }, cursor: cur });
      this.awareness.meta.set(id, { clock: (this.awareness.meta.get(id)?.clock || 0) + 1, lastUpdated: Date.now() });
      this.awareness.emit('change', [{ added: [], updated: [id], removed: [] }, REMOTE]);
    }
    localCursorChanged() {
      if (!this.participant || !this.channel || !this.rt) return;
      clearTimeout(this.timers.cur);
      this.timers.cur = setTimeout(() => {
        const cur = this.awareness.getLocalState()?.cursor ?? null;
        this.send('cur', { c: String(this.ydoc.clientID), cur });
      }, 120);
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
        if (!ch && key && !this.dead) { ch = await tryJoin('classdoc-' + key, false); kind = 'public'; }
        if (this.dead) { if (ch) try { sb.removeChannel(ch); } catch (e) { /* ignore */ } return; }
        this.channel = ch; this.rtKind = ch ? kind : null; this.rt = this.rtKind;
        this.renderStatus();
        if (ch) { this.send('hello', {}); this.schedulePull(80); } // pull now (announces my presence), then every 15 s + on every poke
      })();
    }
    send(event, payload) {
      if (!this.channel || !this.rt || !this.participant) return;
      try { this.channel.send({ type: 'broadcast', event, payload }); } catch (e) { /* the next pull covers it */ }
    }
    poke(kind) { this.send(kind, { g: this.gen }); }

    // ── actions ──
    click(e) {
      const el = e.target.closest('[data-cd]'); if (!el || !this.host.contains(el)) {
        const menu = this.host.querySelector('.cd-menu'); if (menu && !menu.hidden && !e.target.closest('.cd-menu-wrap')) this.toggleMenu(false);
        return;
      }
      const a = el.dataset.cd;
      if (a !== 'export-menu') this.toggleMenu(false);
      switch (a) {
        case 'fmt': this.fmt(el.dataset.k); break;
        case 'lock': this.toggleLock(el); break;
        case 'paste': this.pasteDialog(); break;
        case 'paste-pick': this.pasteClass(el.dataset.id, el); break;
        case 'history': this.historyDialog(); break;
        case 'ver-open': this.previewVersion(el.dataset.id); break;
        case 'ver-restore': this.restoreVersion(el.dataset.id, el); break;
        case 'ver-save': this.saveVersion(el); break;
        case 'sheet-close': this.closeSheet(); break;
        case 'export-menu': this.toggleMenu(); break;
        case 'print': this.print(); break;
        case 'dl-html': this.downloadHtml(); break;
        case 'dl-md': this.downloadMd(); break;
        case 'close': if (this.opts.onClose) this.opts.onClose(); break;
      }
    }
    toggleMenu(force) {
      const m = this.host.querySelector('.cd-menu'); const b = this.host.querySelector('[data-cd="export-menu"]'); if (!m) return;
      const open = force === undefined ? m.hidden : !!force; m.hidden = !open; if (b) b.setAttribute('aria-expanded', String(open));
    }
    fmt(k) {
      const ed = this.editor; if (!ed || !this.canEdit) return;
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
    async toggleLock(btn) {
      if (!this.isTeacher || (typeof vaBlocked === 'function' && vaBlocked())) return;
      btn.disabled = true;
      const want = !this.info.locked;
      const { data, error } = await rpc('classdoc_set_lock', { p_session: this.sid, p_locked: want });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      this.info.locked = !!data?.locked; this.updateUi(); this.poke('lock');
      toast(tr(this.info.locked ? 'Locked: students can read but not edit.' : 'Unlocked: students can edit again.'), 'ok');
    }
    sheet(html) {
      const s = this.host.querySelector('.cd-sheet'); if (!s) return null;
      s.innerHTML = `<div class="cd-sheet-box" role="dialog" aria-modal="true">${html}</div>`; s.hidden = false;
      setTimeout(() => s.querySelector('button,input,select')?.focus(), 30);
      return s;
    }
    closeSheet() { const s = this.host.querySelector('.cd-sheet'); if (s) { s.hidden = true; s.innerHTML = ''; } try { this.preview?.destroy(); } catch (e) { /* ignore */ } this.preview = null; }

    // ── paste a saved class (student handout only) ──
    async pasteDialog() {
      if (!this.isTeacher) return;
      if ((typeof plannings === 'undefined' || !plannings.length) && typeof loadPlannings === 'function') { try { await loadPlannings(); } catch (e) { /* ignore */ } }
      const list = (typeof plannings !== 'undefined' && Array.isArray(plannings)) ? plannings : [];
      const rows = list.map(p => {
        const ok = !!String(p.student || '').trim();
        return `<li class="cd-pick${ok ? '' : ' off'}"><div class="cd-pick-main"><b data-no-i18n>${H(p.title || '—')}</b><span class="cd-pick-meta" data-no-i18n>${H(fDT(p.date))}</span>
          ${ok ? '' : `<span class="cd-pick-note">${H(tr('No student handout yet: open it in Classes and the handout is prepared there.'))}</span>`}</div>
          <button type="button" class="tree-btn${ok ? ' primary' : ''}" data-cd="paste-pick" data-id="${H(p.id)}"${ok ? '' : ' disabled'}>${H(tr('Insert'))}</button></li>`;
      }).join('');
      this.sheet(`<div class="cd-sheet-h"><b>🎒 <span>Paste a class</span></b><button type="button" class="cd-x" data-cd="sheet-close" aria-label="${H(tr('Close'))}">✕</button></div>
        <p class="cd-sheet-sub">We insert the <b>student handout</b> of the class (without answers or teacher notes) where your cursor is. The teacher guide is never shared here.</p>
        ${rows ? `<ul class="cd-pick-list">${rows}</ul>` : `<div class="cd-empty">${H(tr("You don't have saved classes yet. Create one in Classes and save it."))}</div>`}`);
    }
    pasteClass(id, btn) {
      if (!this.isTeacher || !this.canEdit) return;
      const p = (typeof plannings !== 'undefined' ? plannings : []).find(x => String(x.id) === String(id));
      if (!p || !String(p.student || '').trim()) return;
      // the handout is cleaned again here (answer keys, "Answer: …" lines, teacher timings) — never the teacher guide
      const text = typeof cleanStudentHandout === 'function' ? cleanStudentHandout(p.student) : p.student;
      const html = handoutToHtml(text, '');
      if (btn) btn.disabled = true;
      this.editor.chain().focus().insertContent(html).run();
      this.closeSheet();
      toast(tr('Student handout inserted ✓'), 'ok');
    }

    // ── history: versions, preview, restore (teacher) ──
    async historyDialog() {
      const s = this.sheet(`<div class="cd-sheet-h"><b>🕘 <span>History</span></b><button type="button" class="cd-x" data-cd="sheet-close" aria-label="${H(tr('Close'))}">✕</button></div><div class="cd-loading">${H(tr('Loading…'))}</div>`);
      const { data, error } = await rpc('classdoc_versions', { p_session: this.sid });
      if (!s || s.hidden) return;
      const box = s.querySelector('.cd-sheet-box');
      if (error) { box.querySelector('.cd-loading').textContent = tr('Could not load the history.'); return; }
      const L = { auto: 'Automatic', class_end: 'End of class', manual: 'Saved by the teacher', before_restore: 'Before a restore' };
      const items = (data || []).map(v => `<li class="cd-ver"><button type="button" class="cd-ver-open" data-cd="ver-open" data-id="${H(v.id)}"><b>${H(tr(L[v.label] || v.label))}</b>
        <span class="cd-pick-meta" data-no-i18n>${H(fDT(v.created_at))}${v.by ? ' · ' + H(v.by) : ''}</span></button></li>`).join('');
      box.innerHTML = `<div class="cd-sheet-h"><b>🕘 <span>History</span></b><button type="button" class="cd-x" data-cd="sheet-close" aria-label="${H(tr('Close'))}">✕</button></div>
        <p class="cd-sheet-sub">${H(tr(this.isTeacher ? 'Versions are saved every 10 minutes while people write, at the end of the class and when you save one. Open one to see it; you can restore it.' : 'Versions are saved every 10 minutes while people write and at the end of the class. Only the teacher can restore one.'))}</p>
        ${this.isTeacher ? `<div class="gc-btn-row"><button type="button" class="tree-btn" data-cd="ver-save">💾 <span>Save a version now</span></button></div>` : ''}
        ${items ? `<ul class="cd-ver-list">${items}</ul>` : `<div class="cd-empty">${H(tr('No versions yet.'))}</div>`}
        <div class="cd-preview-wrap" hidden><div class="cd-preview-h"><b class="cd-preview-title"></b> ${this.isTeacher ? `<button type="button" class="tree-btn danger" data-cd="ver-restore">↩ <span>Restore this version</span></button>` : ''}</div><div class="cd-preview cd-page" data-no-i18n></div></div>`;
    }
    async previewVersion(id) {
      const s = this.host.querySelector('.cd-sheet'); if (!s) return;
      const { data, error } = await rpc('classdoc_version', { p_version: id });
      if (error || !data) { toast('Error: ' + (error?.message || ''), 'err'); return; }
      const { Y, Editor, StarterKit, Link, Table, TableRow, TableHeader, TableCell, Collaboration } = this.M;
      const doc = new Y.Doc(); (data.parts || []).forEach(p => Y.applyUpdate(doc, fromB64(p)));
      const wrap = s.querySelector('.cd-preview-wrap'); const pv = s.querySelector('.cd-preview'); if (!wrap || !pv) return;
      try { this.preview?.destroy(); } catch (e) { /* ignore */ }
      pv.innerHTML = '';
      this.preview = new Editor({ element: pv, editable: false, extensions: [StarterKit.configure({ history: false }), Link.configure({ openOnClick: false }), Table, TableRow, TableHeader, TableCell, Collaboration.configure({ document: doc })] });
      const L = { auto: 'Automatic', class_end: 'End of class', manual: 'Saved by the teacher', before_restore: 'Before a restore' };
      wrap.querySelector('.cd-preview-title').textContent = `${tr(L[data.label] || data.label)} · ${fDT(data.created_at)}`;
      const rb = wrap.querySelector('[data-cd="ver-restore"]'); if (rb) rb.dataset.id = id;
      wrap.hidden = false; s.querySelectorAll('.cd-ver-open').forEach(b => b.classList.toggle('on', b.dataset.id === id));
      wrap.scrollIntoView({ block: 'nearest' });
    }
    async restoreVersion(id, btn) {
      if (!this.isTeacher || !id || (typeof vaBlocked === 'function' && vaBlocked())) return;
      if (!btn.classList.contains('confirm')) { btn.classList.add('confirm'); btn.innerHTML = `<span>${H(tr('Click again: everyone sees this version'))}</span>`; setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.innerHTML = `↩ <span>${H(tr('Restore this version'))}</span>`; } }, 4000); return; }
      btn.disabled = true;
      await this.flush();
      const { error } = await rpc('classdoc_restore', { p_version: id });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      this.closeSheet(); this.poke('poke');
      const { data } = await rpc('classdoc_open', { p_session: this.sid });
      if (data && !this.dead) { this.info = data; this.rebuild(data); toast(tr('Version restored ✓'), 'ok'); }
    }
    async saveVersion(btn) {
      if (!this.isTeacher) return;
      btn.disabled = true; await this.flush();
      const { data, error } = await rpc('classdoc_add_version', { p_session: this.sid, p_label: 'manual' });
      btn.disabled = false;
      if (error) { toast('Error: ' + error.message, 'err'); return; }
      toast(tr(data?.created ? 'Version saved ✓' : 'The document is empty: nothing to save yet.'), data?.created ? 'ok' : 'err');
      if (data?.created) this.historyDialog();
    }

    // ── export ──
    print() {
      document.body.classList.add('cd-printing'); this.host.classList.add('cd-print-root');
      const done = () => { document.body.classList.remove('cd-printing'); this.host.classList.remove('cd-print-root'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      try { window.print(); } finally { setTimeout(done, 1500); }
    }
    htmlDoc() {
      const s = this.info.session || {};
      return `<!DOCTYPE html><html lang="${typeof uiLang !== 'undefined' ? uiLang : 'es'}"><head><meta charset="UTF-8"><title>${H(s.title || 'Tero Class')}</title>
<style>body{font-family:Inter,Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1a1a1a;line-height:1.65}h1,h2,h3{line-height:1.3}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccc;padding:6px 8px;vertical-align:top}th{background:#f3eeff}blockquote{border-left:3px solid #d4c5f0;margin:8px 0;padding:2px 12px;color:#444}.meta{color:#888;font-size:13px;border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:16px}</style></head>
<body><h1>${H(s.title || '')}</h1><div class="meta">${H(s.group_name || '')}${s.group_name ? ' · ' : ''}${H(fDT(s.starts_at))} · ${H(tr('Class document'))} · Tero Class</div>${this.editor.getHTML()}</body></html>`;
    }
    downloadHtml() { download(fileBase(this.info) + '.html', this.htmlDoc(), 'text/html;charset=utf-8'); }
    downloadMd() {
      const s = this.info.session || {};
      const md = `# ${s.title || ''}\n\n_${s.group_name ? s.group_name + ' · ' : ''}${fDT(s.starts_at)}_\n\n` + toMarkdown(this.editor.getJSON());
      download(fileBase(this.info) + '.md', md, 'text/markdown;charset=utf-8');
    }

    async close() { try { await Promise.race([this.flush(), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* ignore */ } this.destroy(); }
    destroy(keepDom) {
      if (this.dead) return; this.dead = true;
      Object.values(this.timers).forEach(t => clearTimeout(t));
      document.removeEventListener('visibilitychange', this.onVis);
      this.host.removeEventListener('click', this.onClick);
      this.host.removeEventListener('mousedown', this.onDown);
      if (this.channel) { try { sb.removeChannel(this.channel); } catch (e) { /* ignore */ } this.channel = null; }
      try { this.preview?.destroy(); } catch (e) { /* ignore */ }
      try { this.editor?.destroy(); } catch (e) { /* ignore */ }
      try { this.awareness?.destroy(); } catch (e) { /* ignore */ }
      try { this.ydoc?.destroy(); } catch (e) { /* ignore */ }
      if (!keepDom) this.host.innerHTML = '';
    }
  }

  // ── full-screen overlay ──
  let overlay = null;
  async function open(sessionId, opts = {}) {
    if (!sessionId) return null;
    if (overlay) await closeOverlay();
    let el = document.getElementById('cd-overlay');
    if (!el) { el = document.createElement('div'); el.id = 'cd-overlay'; el.className = 'cd-overlay'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', tr('Class document')); document.body.appendChild(el); }
    el.innerHTML = '<div class="cd-overlay-box"></div>'; el.classList.add('active'); document.body.classList.add('cd-open');
    const view = new DocView(el.firstChild, sessionId, { ...opts, onClose: () => closeOverlay() });
    overlay = view;
    await view.init();
    return view;
  }
  async function closeOverlay() {
    const v = overlay; overlay = null; if (v) await v.close();
    const el = document.getElementById('cd-overlay'); if (el) { el.classList.remove('active'); el.innerHTML = ''; }
    document.body.classList.remove('cd-open');
  }
  // embedded (live-class side panel)
  async function mount(host, sessionId, opts = {}) { const v = new DocView(host, sessionId, { ...opts, compact: true }); await v.init(); return v; }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay && document.getElementById('cd-overlay')?.classList.contains('active')) {
      const sh = document.querySelector('#cd-overlay .cd-sheet:not([hidden])');
      if (sh) overlay.closeSheet(); else if (!e.target.closest?.('.ProseMirror')) closeOverlay();
    }
  });
  window.addEventListener('pagehide', () => { if (overlay) overlay.flush(); });

  window.TCClassDoc = { open, close: closeOverlay, mount, loadEditor, _test: { handoutToHtml, toMarkdown, get view() { return overlay; } } };

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // SPANISH (rioplatense "vos")
  // ════════════════════════════════════════════════════════════════════════════════════════════
  if (typeof DB_ERRORS !== 'undefined') DB_ERRORS.unshift(
    [/El docente bloqueó el documento/, 'The teacher locked the document.'], [/Solo lectura: no podés editar este documento/, 'Read-only: you cannot edit this document.'],
    [/Documento desactualizado: volvé a abrirlo/, 'The document changed: open it again.'], [/Cambio demasiado grande/, 'That change is too big.'],
    [/El documento es demasiado grande/, 'The document is too big.'], [/Cambio inválido/, 'Invalid change.'], [/Versión inválida/, 'Invalid version.']
  );
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'Class document': 'Documento de la clase', 'Opening the class document…': 'Abriendo el documento de la clase…',
    'Could not load the editor. Check your connection and try again.': 'No se pudo cargar el editor. Revisá tu conexión y probá de nuevo.',
    "You don't have access to this class document.": 'No tenés acceso a este documento de clase.', 'Could not open the class document.': 'No se pudo abrir el documento de la clase.',
    'Reader': 'Lector', 'Write here… Everyone in the class sees it as you type.': 'Escribí acá… Todos en la clase lo ven mientras escribís.',
    'This document is empty.': 'Este documento está vacío.', 'A previous version of the document was restored.': 'Se restauró una versión anterior del documento.',
    'People in the document': 'Personas en el documento', 'Paste a class': 'Pegar una clase', 'History': 'Historial', 'Export': 'Exportar',
    'Print / PDF': 'Imprimir / PDF', 'Download HTML': 'Descargar HTML', 'Download Markdown': 'Descargar Markdown', 'Formatting': 'Formato',
    'Heading 1': 'Título 1', 'Heading 2': 'Título 2', 'Heading 3': 'Título 3', 'Normal text': 'Texto normal', 'Bold': 'Negrita', 'Italic': 'Cursiva',
    'Strikethrough': 'Tachado', 'Bulleted list': 'Lista con viñetas', 'Numbered list': 'Lista numerada', 'Quote': 'Cita', 'Link': 'Enlace',
    'Insert table': 'Insertar tabla', 'Add row': 'Agregar fila', 'Add column': 'Agregar columna', 'Delete row': 'Borrar fila', 'Delete column': 'Borrar columna',
    'Delete table': 'Borrar tabla', 'Undo': 'Deshacer', 'Redo': 'Rehacer', 'Unlock for students': 'Desbloquear para estudiantes', 'Lock for students': 'Bloquear para estudiantes',
    'View as is read-only.': '"Ver como" es solo lectura.',
    'Read-only: institution admins can read the class document but not edit it.': 'Solo lectura: los admins de la institución pueden leer el documento de la clase pero no editarlo.',
    'The teacher locked the document: you can read it but not edit it.': 'El docente bloqueó el documento: podés leerlo pero no editarlo.',
    'Locked for students: only you (and the substitute) can edit.': 'Bloqueado para estudiantes: solo vos (y el suplente) pueden editar.',
    'Connection problem: retrying…': 'Problema de conexión: reintentando…', 'Saving…': 'Guardando…', '● Live': '● En vivo',
    'Live sync unavailable: updates every few seconds': 'Sincronización en vivo no disponible: se actualiza cada pocos segundos',
    'Updates every few seconds': 'Se actualiza cada pocos segundos', 'Read-only': 'Solo lectura', 'All changes saved': 'Todos los cambios guardados',
    'you': 'vos', 'person here': 'persona acá', 'people here': 'personas acá',
    'The teacher locked the document: your last change was not saved.': 'El docente bloqueó el documento: tu último cambio no se guardó.',
    'The teacher locked the document.': 'El docente bloqueó el documento.', 'The teacher unlocked the document: you can edit again.': 'El docente desbloqueó el documento: podés editar de nuevo.',
    'Link address (https://…). Leave it empty to remove the link.': 'Dirección del enlace (https://…). Dejala vacía para quitar el enlace.', 'Invalid link.': 'Enlace inválido.',
    'Locked: students can read but not edit.': 'Bloqueado: los estudiantes pueden leer pero no editar.', 'Unlocked: students can edit again.': 'Desbloqueado: los estudiantes pueden editar de nuevo.',
    'No student handout yet: open it in Classes and the handout is prepared there.': 'Todavía no tiene material del alumno: abrila en Clases y el material se prepara ahí.',
    'Insert': 'Insertar', 'We insert the': 'Insertamos el', 'student handout': 'material del alumno',
    'of the class (without answers or teacher notes) where your cursor is. The teacher guide is never shared here.': 'de la clase (sin respuestas ni notas docentes) donde está tu cursor. La guía docente nunca se comparte acá.',
    "You don't have saved classes yet. Create one in Classes and save it.": 'Todavía no tenés clases guardadas. Creá una en Clases y guardala.',
    'Student handout inserted ✓': 'Material del alumno insertado ✓', 'Loading…': 'Cargando…', 'Could not load the history.': 'No se pudo cargar el historial.',
    'Automatic': 'Automática', 'End of class': 'Fin de la clase', 'Saved by the teacher': 'Guardada por el docente', 'Before a restore': 'Antes de restaurar',
    'Versions are saved every 10 minutes while people write, at the end of the class and when you save one. Open one to see it; you can restore it.': 'Las versiones se guardan cada 10 minutos mientras se escribe, al terminar la clase y cuando guardás una. Abrí una para verla; podés restaurarla.',
    'Versions are saved every 10 minutes while people write and at the end of the class. Only the teacher can restore one.': 'Las versiones se guardan cada 10 minutos mientras se escribe y al terminar la clase. Solo el docente puede restaurar una.',
    'Save a version now': 'Guardar una versión ahora', 'No versions yet.': 'Todavía no hay versiones.', 'Restore this version': 'Restaurar esta versión',
    'Click again: everyone sees this version': 'Hacé clic de nuevo: todos van a ver esta versión', 'Version restored ✓': 'Versión restaurada ✓',
    'Version saved ✓': 'Versión guardada ✓', 'The document is empty: nothing to save yet.': 'El documento está vacío: todavía no hay nada para guardar.',
    'Close': 'Cerrar', 'The teacher locked the document.': 'El docente bloqueó el documento.', 'Read-only: you cannot edit this document.': 'Solo lectura: no podés editar este documento.',
    'The document changed: open it again.': 'El documento cambió: volvé a abrirlo.', 'That change is too big.': 'Ese cambio es demasiado grande.',
    'The document is too big.': 'El documento es demasiado grande.', 'Invalid change.': 'Cambio inválido.', 'Invalid version.': 'Versión inválida.',
  });
})();
