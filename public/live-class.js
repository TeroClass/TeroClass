/* TeroClass · Live class (Aula en vivo)
 * ------------------------------------------------------------------------------------------
 * In-app video classroom. Today it runs in DEMO mode (DemoProvider: simulated participants,
 * nothing leaves the browser, no cost). It is ready for LiveKit: when /api/class/config says
 * {configured:true} (LIVEKIT_URL + LIVEKIT_API_KEY + LIVEKIT_API_SECRET set in Vercel), the
 * livekit-client SDK is loaded from jsDelivr and LiveKitProvider is used instead.
 *
 * Depends on globals from index.html: sb, currentUser, plannings, currentResult, esc, showToast,
 * showPanel, formatDoc, trText, uiLang, I18N_ES, I18N_RULES_ES, loadScriptOnce; and on public/insights-view.js
 * (window.TCInsightsView: sample data + insights renderers shared with the Insights panels).
 * Ending a class from the calendar (teacher / substitute) stores demo insights for that class
 * (generate_demo_insights) and opens them in Insights (public/insights-panel.js).
 * All user data (names, titles, chat, plan text) is escaped with esc() / formatDoc().
 */
(function () {
  'use strict';

  const LK_VERSION = '2.22.3';
  const LK_CDN = `https://cdn.jsdelivr.net/npm/livekit-client@${LK_VERSION}/dist/livekit-client.umd.js`;
  const CONSENT_VERSION = '2026-10';
  const V = window.TCInsightsView; // shared insights view (loaded before this file)
  const DEMO_BANNER = V.DEMO_BANNER;

  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const toast = (m, t) => { if (typeof showToast === 'function') showToast(tr(m), t); };
  const pad2 = n => String(Math.floor(n)).padStart(2, '0');
  const mmss = s => { s = Math.max(0, Math.round(s)); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2((s % 3600) / 60)}:${pad2(s % 60)}` : `${pad2(s / 60)}:${pad2(s % 60)}`; };
  const initials = name => (String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
  const COLORS = ['#7c5cbf', '#0891b2', '#d97706', '#059669', '#db2777', '#4f46e5', '#b45309', '#0f766e', '#9333ea'];
  const colorFor = s => COLORS[[...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
  const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,24}$/;

  // ════════════════════════════════════════════════════════════════════════════════════════
  // SAMPLE PLANS (demo). The sample insights live in public/insights-view.js (TCInsightsView.SAMPLES).
  // ════════════════════════════════════════════════════════════════════════════════════════
  const SAMPLE_PLAN_EN = `Week 3 - Class 2 - B1 - Making plans
Today's Objectives:
- Talk about future plans with "going to", present continuous and "will"
- Make and respond to suggestions
Warm-up: weekend plans (5 min)
- In pairs: "What are you doing this weekend?"
- Share one plan with the class
Activity 1: future forms (10 min)
- Going to → intentions: I'm going to study abroad.
- Present continuous → arrangements: We're meeting at 6.
- Will → spontaneous decisions: I'll help you!
Activity 2: plan the class trip (15 min)
- Pairs choose destination, budget and schedule
- Use: Why don't we…? / How about + -ing?
Presentations (10 min)
- Each pair presents their plan in 2 minutes
- The class votes
Closing & exit ticket (5 min)
- Write 3 sentences about your next holiday`;

  const SAMPLE_PLAN_ES = `Semana 5 - Clase 1 - Química 3°B - Reacciones químicas
Objetivos de hoy:
- Reconocer reactivos y productos en una ecuación
- Balancear ecuaciones aplicando la conservación de la masa
Inicio: ¿qué pasa cuando algo se quema? (10 min)
- Video corto de una combustión
- Lluvia de ideas: ¿desaparece la materia?
Actividad 1: ley de conservación de la masa (15 min)
- Demostración con bicarbonato y vinagre en una bolsa cerrada
- Registro de la masa antes y después
Actividad 2: balanceo de ecuaciones en parejas (20 min)
- H2 + O2 → H2O
- CH4 + O2 → CO2 + H2O
- Regla: solo se cambian coeficientes, nunca subíndices
Cierre y ticket de salida (5 min)
- ¿Por qué no podemos cambiar los subíndices?`;

  const SAMPLES = V.SAMPLES;

  // ════════════════════════════════════════════════════════════════════════════════════════
  // PROVIDERS
  // A provider owns the connection to the media server. The UI only talks to this interface:
  //   connect({room,name,role,consent,recorded,minor,guardianOk,localStream}) → Promise
  //   disconnect(), setMicrophoneEnabled(on), setCameraEnabled(on),
  //   startScreenShare(stream), stopScreenShare(), sendChat(text), setHandRaised(up),
  //   setRecording('on'|'paused'|'off'), attachVideo(participantId, videoEl), participants(),
  //   attachScreen(participantId, videoEl) (someone else's shared screen)
  // Events (on/off): 'participants' (list), 'speaking' (Set of ids), 'chat' ({from,name,text,ts}),
  //   'hand' ({id,up}), 'recording' (state), 'screens' ([{id,name}] of remote screen shares), 'disconnected'.
  // ════════════════════════════════════════════════════════════════════════════════════════
  class LiveProvider {
    constructor() { this._h = {}; this._list = []; }
    get kind() { return 'base'; }
    on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return this; }
    off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter(f => f !== fn); return this; }
    emit(ev, ...args) { (this._h[ev] || []).slice().forEach(f => { try { f(...args); } catch (e) { console.warn('live-class handler', e); } }); }
    participants() { return this._list; }
    async connect() { throw new Error('connect() not implemented'); }
    async disconnect() {}
    async setMicrophoneEnabled() {}
    async setCameraEnabled() {}
    async startScreenShare() {}
    async stopScreenShare() {}
    async sendChat() {}
    async setHandRaised() {}
    async setRecording() {}
    attachVideo() { return false; }
    attachScreen() { return false; }
  }

  // ── Demo: simulated classmates, nothing leaves the browser ──
  const DEMO_PEOPLE = [
    { name: 'Valentina Ruiz', consent: { recording: true, ai_analysis: true, storage: true } },
    { name: 'Mateo Fernández', consent: { recording: true, ai_analysis: true, storage: false } },
    { name: 'Sofía Pereira', consent: { recording: true, ai_analysis: true, storage: true } },
    { name: 'Lucas Silva', consent: { recording: false, ai_analysis: false, storage: false }, cam: false },
    { name: 'Martina Gómez', minor: true, guardianOk: true, consent: { recording: true, ai_analysis: true, storage: true } },
    { name: 'Joaquín Castro', minor: true, guardianOk: false, consent: { recording: false, ai_analysis: false, storage: false }, mic: false },
  ];
  class DemoProvider extends LiveProvider {
    get kind() { return 'demo'; }
    async connect(o) {
      this.o = o;
      const local = { id: 'local', isLocal: true, name: o.name, role: o.role, mic: !!o.mic, cam: !!o.cam, consent: o.consent, recorded: o.recorded, minor: o.minor, guardianOk: o.guardianOk, hand: false };
      const others = DEMO_PEOPLE.map((p, i) => ({
        id: 'sim-' + i, name: p.name, role: 'student', mic: p.mic !== false, cam: p.cam !== false, consent: p.consent,
        recorded: !!p.consent.recording && (!p.minor || !!p.guardianOk), minor: !!p.minor, guardianOk: !!p.guardianOk, hand: false,
      }));
      if (o.role !== 'teacher') { others.splice(5); others.unshift({ id: 'sim-t', name: 'Prof. Laura Méndez', role: 'teacher', mic: true, cam: true, consent: { recording: true, ai_analysis: true, storage: true }, recorded: true, minor: false, guardianOk: false, hand: false }); }
      this._list = [local, ...others];
      this._speaker = null; this._hold = 0; this._t0 = Date.now();
      this._timers = [setInterval(() => this._tick(), 900)];
      this._later(7000, () => this.emit('chat', { from: 'sim-1', name: 'Mateo Fernández', text: o.role === 'teacher' ? 'Can you repeat the last example, please?' : 'Hi everyone!', ts: Date.now() }));
      this._later(11000, () => this._setHand('sim-2', true));
      this._later(26000, () => this._setHand('sim-2', false));
      if (o.role !== 'teacher') this._later(3000, () => this.emit('recording', 'on'));
      if (o.role !== 'teacher') this._later(4000, () => this._startSimShare(o));
      await new Promise(r => setTimeout(r, 250)); // feels like a connection
      this.emit('participants', this._list);
    }
    _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }
    // Demo: "Prof. Laura Méndez" shares a slide (a canvas stream), so students see a shared screen
    _startSimShare(o) {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      if (!c.captureStream) return;
      const g = c.getContext('2d'); const t0 = Date.now();
      const draw = () => {
        g.fillStyle = '#f7f5fc'; g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#7c5cbf'; g.fillRect(0, 0, 1280, 96);
        g.fillStyle = '#fff'; g.font = '600 40px Inter, sans-serif'; g.fillText(String(o.title || 'Class').slice(0, 48), 48, 62);
        g.fillStyle = '#1a1a1a'; g.font = '32px Inter, sans-serif';
        ['• 1 ✓', '• 2 …', '• 3'].forEach((l, i) => g.fillText(l, 64, 200 + i * 64));
        const sec = Math.floor((Date.now() - t0) / 1000); g.fillStyle = '#888'; g.font = '24px Inter, sans-serif';
        g.fillText(`${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`, 1160, 690);
      };
      draw();
      this._screenStream = c.captureStream(5);
      this._timers.push(setInterval(draw, 500));
      this._screens = [{ id: 'sim-t', name: 'Prof. Laura Méndez' }];
      this.emit('screens', this._screens);
    }
    attachScreen(id, el) { if (id === 'sim-t' && this._screenStream) { el.srcObject = this._screenStream; return true; } return false; }
    _setHand(id, up) { const p = this._list.find(x => x.id === id); if (!p) return; p.hand = up; this.emit('hand', { id, up }); this.emit('participants', this._list); }
    _tick() {
      if (this._hold-- > 0 && this._speaker) { this.emit('speaking', new Set([this._speaker])); return; }
      const teacher = this._list.find(p => p.role === 'teacher');
      const students = this._list.filter(p => p.role !== 'teacher' && p.mic && !p.isLocal);
      const local = this._list.find(p => p.isLocal);
      const r = Math.random();
      let next = null;
      if (r < 0.45) next = teacher && teacher.mic ? teacher.id : null;
      else if (r < 0.88 && students.length) next = students[Math.floor(Math.random() * students.length)].id;
      else if (local && local.role !== 'teacher' && local.mic && r < 0.95) next = local.id;
      this._speaker = next; this._hold = 1 + Math.floor(Math.random() * 4);
      this.emit('speaking', new Set(next ? [next] : []));
    }
    async disconnect() { (this._timers || []).forEach(t => { clearInterval(t); clearTimeout(t); }); this._timers = []; this._h = {}; if (this._screenStream) { this._screenStream.getTracks().forEach(t => t.stop()); this._screenStream = null; } }
    _local() { return this._list.find(p => p.isLocal); }
    async setMicrophoneEnabled(on) { const l = this._local(); if (l) l.mic = on; this.emit('participants', this._list); }
    async setCameraEnabled(on) { const l = this._local(); if (l) l.cam = on; this.emit('participants', this._list); }
    async setHandRaised(up) { this._setHand('local', up); }
    async sendChat(text) { this.emit('chat', { from: 'local', name: this.o.name, text, ts: Date.now(), self: true }); }
    async setRecording(state) { this.emit('recording', state); }
    muteRemote(id) { const p = this._list.find(x => x.id === id); if (p) { p.mic = false; this.emit('participants', this._list); } }
  }

  // ── LiveKit: real rooms. Loaded only when the server reports {configured:true}. ──
  // Uses the livekit-client UMD global (window.LivekitClient).
  class LiveKitProvider extends LiveProvider {
    get kind() { return 'livekit'; }
    async connect(o) {
      const LK = window.LivekitClient;
      if (!LK || !LK.Room) throw new Error('LiveKit SDK not loaded');
      this.LK = LK; this.o = o;
      const { data: { session } = {} } = await sb.auth.getSession();
      const r = await fetch('/api/class/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session?.access_token || '') },
        body: JSON.stringify({ room: o.room, name: o.name, role: o.role, consent: o.consent, minor: o.minor, guardian: o.guardian }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.token) throw new Error(j.error || 'Could not join the class.');
      const room = new LK.Room({ adaptiveStream: true, dynacast: true });
      this.room = room;
      const E = LK.RoomEvent;
      const sync = () => this._sync();
      room
        .on(E.ParticipantConnected, sync)
        .on(E.ParticipantDisconnected, sync)
        .on(E.TrackSubscribed, (track) => {
          // remote voices must be attached to an <audio> element to be heard
          if (track.kind === 'audio') { const el = track.attach(); el.className = 'lc-remote-audio'; el.hidden = true; document.body.appendChild(el); }
          sync();
        })
        .on(E.TrackUnsubscribed, (track) => { try { track.detach().forEach(el => { el.srcObject = null; if (el.classList.contains('lc-remote-audio')) el.remove(); }); } catch (e) { /* ignore */ } sync(); })
        .on(E.TrackMuted, sync)
        .on(E.TrackUnmuted, sync)
        .on(E.ParticipantMetadataChanged, sync)
        .on(E.ActiveSpeakersChanged, (speakers) => this.emit('speaking', new Set(speakers.map(s => this._id(s)))))
        .on(E.DataReceived, (payload, participant) => this._onData(payload, participant))
        .on(E.Disconnected, () => this.emit('disconnected'));
      await room.connect(j.url, j.token);
      const lp = room.localParticipant;
      const [a] = o.localStream ? o.localStream.getAudioTracks() : [];
      const [v] = o.localStream ? o.localStream.getVideoTracks() : [];
      if (a) await lp.publishTrack(a, { source: LK.Track.Source.Microphone });
      if (v) await lp.publishTrack(v, { source: LK.Track.Source.Camera, simulcast: true });
      if (a && !o.mic) await lp.setMicrophoneEnabled(false);
      if (v && !o.cam) await lp.setCameraEnabled(false);
      this._sync();
    }
    _id(p) { return p === this.room?.localParticipant ? 'local' : p.identity; }
    _meta(p) { try { return JSON.parse(p.metadata || '{}') || {}; } catch (e) { return {}; } }
    _sync() {
      if (!this.room) return;
      const S = this.LK.Track.Source;
      const toP = (p, isLocal) => {
        const m = this._meta(p);
        const mic = p.getTrackPublication(S.Microphone); const cam = p.getTrackPublication(S.Camera);
        return {
          id: isLocal ? 'local' : p.identity, isLocal, name: p.name || p.identity, role: m.role === 'teacher' ? 'teacher' : 'student',
          mic: !!mic && !mic.isMuted, cam: !!cam && !cam.isMuted, consent: m.consent || {}, recorded: !!m.recorded,
          minor: !!m.minor, guardianOk: !!m.guardian_consent, hand: !!(this._hands && this._hands[isLocal ? 'local' : p.identity]),
        };
      };
      const remotes = Array.from(this.room.remoteParticipants.values());
      this._list = [toP(this.room.localParticipant, true), ...remotes.map(p => toP(p, false))];
      this.emit('participants', this._list);
      // remote screen shares (subscribed and not muted) → their own large tile
      this._screens = remotes.filter(p => { const sp = p.getTrackPublication(S.ScreenShare); return !!(sp && sp.track && !sp.isMuted); })
        .map(p => ({ id: p.identity, name: p.name || p.identity }));
      this.emit('screens', this._screens);
    }
    attachScreen(id, el) {
      if (!this.room) return false;
      const p = this.room.remoteParticipants.get(id);
      const pub = p && p.getTrackPublication(this.LK.Track.Source.ScreenShare);
      if (pub && pub.track) { pub.track.attach(el); return true; }
      return false;
    }
    attachVideo(id, el) {
      if (!this.room || id === 'local') return false;
      const p = this.room.remoteParticipants.get(id);
      const pub = p && p.getTrackPublication(this.LK.Track.Source.Camera);
      if (pub && pub.track) { pub.track.attach(el); return true; }
      return false;
    }
    _send(obj) {
      return this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true });
    }
    _onData(payload, participant) {
      let m; try { m = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
      const id = participant ? participant.identity : 'server';
      if (m.type === 'chat' && typeof m.text === 'string') this.emit('chat', { from: id, name: participant?.name || id, text: m.text.slice(0, 1000), ts: Date.now() });
      if (m.type === 'hand') { (this._hands = this._hands || {})[id] = !!m.up; this.emit('hand', { id, up: !!m.up }); this._sync(); }
      if (m.type === 'rec' && ['on', 'paused', 'off'].includes(m.state) && this._meta(participant || {}).role === 'teacher') this.emit('recording', m.state);
    }
    async setMicrophoneEnabled(on) { await this.room.localParticipant.setMicrophoneEnabled(on); this._sync(); }
    async setCameraEnabled(on) { await this.room.localParticipant.setCameraEnabled(on); this._sync(); }
    async startScreenShare(stream) {
      const [t] = stream ? stream.getVideoTracks() : [];
      if (t) this._screenPub = await this.room.localParticipant.publishTrack(t, { source: this.LK.Track.Source.ScreenShare });
      else await this.room.localParticipant.setScreenShareEnabled(true);
    }
    async stopScreenShare() {
      if (this._screenPub?.track) await this.room.localParticipant.unpublishTrack(this._screenPub.track);
      else await this.room.localParticipant.setScreenShareEnabled(false);
      this._screenPub = null;
    }
    async sendChat(text) { await this._send({ type: 'chat', text }); this.emit('chat', { from: 'local', name: this.o.name, text, ts: Date.now(), self: true }); }
    async setHandRaised(up) { (this._hands = this._hands || {}).local = up; await this._send({ type: 'hand', up }); this.emit('hand', { id: 'local', up }); this._sync(); }
    async setRecording(state) {
      // TODO(live): POST /api/class/recording {room, state} → the recorder worker starts/pauses/stops
      // capturing the audio tracks of participants whose metadata says recorded=true.
      await this._send({ type: 'rec', state });
      this.emit('recording', state);
    }
    async disconnect() { try { await this.room?.disconnect(); } catch (e) { /* ignore */ } document.querySelectorAll('audio.lc-remote-audio').forEach(el => el.remove()); this.room = null; this._h = {}; }
  }

  // Server decides: LiveKit only when the three env vars exist. Any failure → Demo (spends nothing).
  let providerKindCache = null;
  async function detectProviderKind() {
    if (providerKindCache) return providerKindCache;
    let kind = 'demo';
    try {
      const r = await fetch('/api/class/config', { cache: 'no-store' });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (j && j.configured === true) {
        await loadScriptOnce(LK_CDN);
        if (window.LivekitClient) kind = 'livekit';
      }
    } catch (e) { kind = 'demo'; }
    providerKindCache = kind;
    return kind;
  }
  const createProvider = kind => (kind === 'livekit' ? new LiveKitProvider() : new DemoProvider());

  // ════════════════════════════════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════════════════════════════════
  const S = {
    view: 'home',
    planning: null,        // {id,title,content,params}
    sampleKey: 'language',
    sessionTitle: '',
    sessionId: null, sessionRole: null, // calendar session (groups-calendar.js): everyone in it joins the same room
    lobby: null,
    room: null,
    insights: { tab: 'student', student: 0, sub: 'overview', role: 'teacher' },
    reflections: {},       // sampleKey → {evidence,worked,priority,next,reflection}
    messages: {},          // sampleKey:student → text
    timers: [],
  };
  const clearViewTimers = () => { S.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); S.timers = []; };
  const root = () => document.getElementById('lc-root');

  const pickSampleKey = V.pickSampleKey;

  // Timed sections from headings like "Activity 1 (15 min)" / "Actividad 1 (15 minutos)" / "Warm-up – 5'"
  const MIN_RE = /(\d{1,3})\s*(?:min(?:utos?|utes?|s)?\.?|['’′])(?=[\s).,;:\]–-]|$)/i;
  function parsePlanSections(text, fallbackMin) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const sections = []; let intro = []; let cur = null;
    lines.forEach((line, i) => {
      const raw = line.trim();
      const m = raw.match(MIN_RE);
      const isHead = i > 0 && m && raw.length <= 100 && !/^[-•*⏱]/.test(raw) && parseInt(m[1], 10) > 0 && parseInt(m[1], 10) <= 240;
      if (isHead) { cur = { title: raw, minutes: parseInt(m[1], 10), body: [] }; sections.push(cur); }
      else if (cur) cur.body.push(line);
      else if (i > 0) intro.push(line);
    });
    if (!sections.length) sections.push({ title: 'Whole class', minutes: fallbackMin || 45, body: lines.slice(1), generic: true });
    return { title: (lines[0] || '').trim(), intro: intro.join('\n').trim(), sections };
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // SHARED UI
  // ════════════════════════════════════════════════════════════════════════════════════════
  const banner = V.banner;
  const demoChip = V.demoChip;

  function demoSessions() {
    const now = new Date();
    const at = (d, h, m) => { const x = new Date(now); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x; };
    const fmt = d => { try { return d.toLocaleString(typeof uiLocale === 'function' ? uiLocale() : undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return d.toISOString(); } };
    return {
      upcoming: [
        { title: 'Making plans: future forms (B1)', group: 'English B1 · Tue/Thu', when: fmt(at(0, now.getHours() + 1, 0)), people: 8, sample: 'language' },
        { title: 'Reacciones químicas: balanceo de ecuaciones (3°B)', group: 'Química 3°B', when: fmt(at(1, 10, 30)), people: 24, sample: 'chemistry' },
      ],
      past: [
        { title: 'Making plans: future forms (B1)', group: 'English B1 · Tue/Thu', when: fmt(at(-2, 18, 0)), minutes: 45, sample: 'language' },
        { title: 'Reacciones químicas: balanceo de ecuaciones (3°B)', group: 'Química 3°B', when: fmt(at(-5, 10, 30)), minutes: 50, sample: 'chemistry' },
      ],
    };
  }

  function render() {
    const el = root(); if (!el) return;
    el.dataset.view = S.view;
    if (S.view === 'home') el.innerHTML = homeHtml();
    else if (S.view === 'lobby') { el.innerHTML = lobbyHtml(); afterLobbyRender(); }
    else if (S.view === 'room') { el.innerHTML = roomHtml(); afterRoomRender(); }
    else if (S.view === 'processing') el.innerHTML = processingHtml();
    else if (S.view === 'insights') el.innerHTML = insightsHtml();
    const h = el.querySelector('h1'); if (h && S.view !== 'room') { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    el.scrollTop = 0;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // HOME (sessions list)
  // ════════════════════════════════════════════════════════════════════════════════════════
  function homeHtml() {
    const list = (typeof plannings !== 'undefined' && Array.isArray(plannings)) ? plannings : [];
    const ds = demoSessions();
    const opts = list.map(p => `<option value="${esc(p.id)}" data-no-i18n>${esc(p.title || 'Class')}</option>`).join('');
    return `<div class="lc-wrap">
      ${banner()}
      <header class="lc-head">
        <div><h1><span aria-hidden="true">🎥</span> <span>Live class</span></h1>
        <p class="lc-sub">Teach online from TeroClass: video, your class plan beside you, and learning insights after class.</p></div>
        ${demoChip()}
      </header>
      <section class="lc-card lc-start" aria-labelledby="lc-start-h">
        <h2 id="lc-start-h">Start a live class</h2>
        <div class="lc-start-row">
          <div class="lc-field"><label for="lc-plan-select">Class plan</label>
            <select id="lc-plan-select"><option value="">Sample plan (no saved class)</option>${opts}</select></div>
          <button type="button" class="lc-btn lc-primary" data-lc="start" id="lc-start-btn">▶ Start live class</button>
        </div>
        ${list.length ? '' : '<p class="lc-hint">Tip: save a class first and it will appear here with its activity timers.</p>'}
      </section>
      <div class="lc-two">
        <section class="lc-card" aria-labelledby="lc-up-h">
          <h2 id="lc-up-h">Upcoming sessions</h2>
          <ul class="lc-sessions">${ds.upcoming.map((s, i) => `<li class="lc-session">
            <div class="lc-session-main"><div class="lc-session-title" data-no-i18n>${esc(s.title)}</div>
            <div class="lc-session-meta"><span data-no-i18n>${esc(s.when)}</span> · <span data-no-i18n>${esc(s.group)}</span> · <span data-no-i18n>${s.people}</span> <span>participants</span></div></div>
            <button type="button" class="lc-btn" data-lc="join-upcoming" data-i="${i}">Open lobby</button></li>`).join('')}</ul>
        </section>
        <section class="lc-card" aria-labelledby="lc-past-h">
          <h2 id="lc-past-h">Past sessions</h2>
          <ul class="lc-sessions">${ds.past.map((s, i) => `<li class="lc-session">
            <div class="lc-session-main"><div class="lc-session-title" data-no-i18n>${esc(s.title)}</div>
            <div class="lc-session-meta"><span data-no-i18n>${esc(s.when)}</span> · <span data-no-i18n>${s.minutes} min</span> · <span class="lc-chip lc-chip-ok">Insights ready</span></div></div>
            <button type="button" class="lc-btn" data-lc="past-insights" data-i="${i}">View insights</button></li>`).join('')}</ul>
        </section>
      </div>
      <section class="lc-card lc-how" aria-labelledby="lc-how-h">
        <h2 id="lc-how-h">How it works</h2>
        <ol class="lc-steps">
          <li><b>Lobby</b><span>Check your camera and microphone. Each person gives separate consent for recording, AI analysis and storage.</span></li>
          <li><b>Class</b><span>Teach with your plan and activity timers beside the video. A red REC indicator is always visible and you can pause it.</span></li>
          <li><b>Insights</b><span>After class: a recap, progress and feedback for each student, and an observation report for you.</span></li>
        </ol>
        <ul class="lc-privacy">
          <li>Only participants who consent are recorded. The others attend normally.</li>
          <li>Under 18: a parent or guardian must consent.</li>
          <li>Speakers are identified by their own microphone, never by voiceprint. No emotion detection.</li>
          <li>Raw audio is deleted after 30 days.</li>
        </ul>
      </section>
    </div>`;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // LOBBY (preview + consent)
  // ════════════════════════════════════════════════════════════════════════════════════════
  function newLobby() {
    const isStaff = !!currentUser && ['teacher', 'org_admin', 'superadmin'].includes(String(currentUser.role || 'teacher'));
    return {
      name: (currentUser && currentUser.name) || '', role: S.sessionRole || (isStaff ? 'teacher' : 'student'),
      camId: '', micId: '', stream: null, mediaError: '', mic: true, cam: true, level: 0,
      devices: { cams: [], mics: [] },
      consent: { recording: false, ai_analysis: false, storage: false },
      minor: false, guardian: { name: '', email: '', consent: false }, error: '',
    };
  }
  const guardianOk = L => !!(L.guardian.name.trim() && EMAIL_RE.test(L.guardian.email.trim()) && L.guardian.consent);
  const willBeRecorded = L => L.consent.recording && (!L.minor || guardianOk(L));

  function consentSummaryHtml(L) {
    if (willBeRecorded(L)) {
      const parts = [L.consent.ai_analysis ? '<span class="lc-chip lc-chip-ok">AI analysis ✓</span>' : '<span class="lc-chip">No AI analysis</span>',
        L.consent.storage ? '<span class="lc-chip lc-chip-ok">Results stored ✓</span>' : '<span class="lc-chip">Results not stored</span>'];
      return `<span class="lc-chip lc-chip-rec">● You will be recorded</span> ${parts.join(' ')}`;
    }
    if (L.consent.recording && L.minor) return '<span class="lc-chip lc-chip-warn">Waiting for guardian consent</span>';
    return '<span class="lc-chip lc-chip-off">You will join without being recorded</span>';
  }

  function lobbyHtml() {
    const L = S.lobby;
    const c = L.consent;
    return `<div class="lc-wrap lc-lobby">
      ${banner()}
      <button type="button" class="lc-link" data-lc="back-home">${studentBack() ? '← Back to my classes' : '← Back to live classes'}</button>
      <header class="lc-head"><div><h1>Get ready to join</h1><p class="lc-sub" data-no-i18n>${esc(S.sessionTitle)}</p></div>${demoChip()}</header>
      <div class="lc-lobby-grid">
        <section class="lc-card" aria-labelledby="lc-prev-h">
          <h2 id="lc-prev-h">Camera and microphone</h2>
          <div class="lc-preview" id="lc-preview">
            <video id="lc-preview-video" autoplay muted playsinline aria-label="${esc(tr('Your camera preview'))}"></video>
            <div class="lc-preview-off" id="lc-preview-off"><div class="lc-avatar lg" style="background:${colorFor(L.name || 'you')}" data-no-i18n id="lc-preview-initials">${esc(initials(L.name || 'You'))}</div><span id="lc-preview-off-txt">Camera is off</span></div>
            <div class="lc-meter" aria-hidden="true"><span id="lc-meter-bar"></span></div>
          </div>
          <div class="lc-preview-ctrls">
            <button type="button" class="lc-round" id="lc-lobby-mic" data-lc="lobby-mic" aria-pressed="${L.mic}" aria-label="${esc(tr('Microphone'))}">${L.mic ? '🎙️' : '🔇'}</button>
            <button type="button" class="lc-round" id="lc-lobby-cam" data-lc="lobby-cam" aria-pressed="${L.cam}" aria-label="${esc(tr('Camera'))}">${L.cam ? '📷' : '🚫'}</button>
          </div>
          <div class="lc-media-msg" id="lc-media-msg" role="status"></div>
          <div class="lc-field"><label for="lc-cam-select">Camera</label><select id="lc-cam-select"></select></div>
          <div class="lc-field"><label for="lc-mic-select">Microphone</label><select id="lc-mic-select"></select></div>
        </section>
        <section class="lc-card" aria-labelledby="lc-you-h">
          <h2 id="lc-you-h">About you</h2>
          <div class="lc-field"><label for="lc-name">Your name</label><input id="lc-name" type="text" maxlength="80" autocomplete="name" value="${esc(L.name)}"></div>
          <fieldset class="lc-field lc-roles"><legend>Joining as</legend>
            <label class="lc-radio"><input type="radio" name="lc-role" value="teacher" ${L.role === 'teacher' ? 'checked' : ''}> <span>Teacher</span></label>
            <label class="lc-radio"><input type="radio" name="lc-role" value="student" ${L.role === 'student' ? 'checked' : ''}> <span>Student</span></label>
          </fieldset>
          <h2 id="lc-consent-h">Recording and privacy</h2>
          <p class="lc-hint">This class can be recorded to create learning insights. Each consent is separate and optional — you can join without any of them.</p>
          <div class="lc-consents" role="group" aria-labelledby="lc-consent-h">
            <label class="lc-check"><input type="checkbox" id="lc-c-recording" ${c.recording ? 'checked' : ''}> <span><b>Recording.</b> <span>I agree that my voice is recorded during this class.</span></span></label>
            <label class="lc-check"><input type="checkbox" id="lc-c-ai" ${c.ai_analysis ? 'checked' : ''} ${c.recording ? '' : 'disabled'}> <span><b>AI analysis.</b> <span>I agree that AI transcribes and analyses my participation to create learning insights.</span></span></label>
            <label class="lc-check"><input type="checkbox" id="lc-c-storage" ${c.storage ? 'checked' : ''} ${c.recording ? '' : 'disabled'}> <span><b>Storage.</b> <span>I agree that the results are kept in my TeroClass record. Raw audio is deleted after 30 days.</span></span></label>
            <label class="lc-check lc-minor"><input type="checkbox" id="lc-minor" ${L.minor ? 'checked' : ''}> <span><b>I'm under 18</b></span></label>
          </div>
          <div class="lc-guardian" id="lc-guardian" ${L.minor ? '' : 'hidden'}>
            <p class="lc-guardian-note"><span aria-hidden="true">👪</span> <span>A parent or guardian must give consent for participants under 18.</span></p>
            <div class="lc-field"><label for="lc-g-name">Guardian's full name</label><input id="lc-g-name" type="text" maxlength="120" value="${esc(L.guardian.name)}"></div>
            <div class="lc-field"><label for="lc-g-email">Guardian's email</label><input id="lc-g-email" type="email" maxlength="254" value="${esc(L.guardian.email)}"></div>
            <label class="lc-check"><input type="checkbox" id="lc-g-consent" ${L.guardian.consent ? 'checked' : ''}> <span>I am the parent or guardian and I give the consents marked above.</span></label>
            <p class="lc-fine">Demo: kept only in this browser tab, never sent.</p>
          </div>
          <div class="lc-consent-summary" id="lc-consent-summary" aria-live="polite">${consentSummaryHtml(L)}</div>
          <div class="lc-error" id="lc-lobby-err" role="alert">${L.error ? esc(tr(L.error)) : ''}</div>
          <button type="button" class="lc-btn lc-primary lc-join" data-lc="join" id="lc-join">Join class</button>
          <p class="lc-fine">No emotion detection. Speakers are identified by their own microphone, never by voiceprint. You can stop being recorded at any time.</p>
        </section>
      </div>
    </div>`;
  }

  function mediaErrorText(err) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera and microphone access is blocked. You can still join without them, or allow access in your browser and try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera or microphone was found. You can still join and use the chat.';
    if (n === 'NotReadableError') return 'Your camera or microphone is being used by another app.';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'This browser cannot use the camera here (it needs a secure https connection).';
    return 'Could not start the camera or microphone.';
  }

  async function startPreview() {
    const L = S.lobby; if (!L) return;
    stopStream(L.stream); L.stream = null; L.mediaError = '';
    stopMeter();
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { L.mediaError = mediaErrorText(null); updatePreviewUi(); return; }
    const v = L.camId ? { deviceId: { exact: L.camId } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
    const a = L.micId ? { deviceId: { exact: L.micId }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true };
    let stream = null; let firstErr = null;
    for (const c of [{ video: v, audio: a }, { audio: a }, { video: v }]) {
      try { stream = await md.getUserMedia(c); break; } catch (e) { firstErr = firstErr || e; if (e && e.name === 'NotAllowedError') break; }
    }
    if (S.view !== 'lobby' || S.lobby !== L) { stopStream(stream); return; }
    L.stream = stream;
    if (!stream) L.mediaError = mediaErrorText(firstErr);
    else if (!stream.getVideoTracks().length) L.mediaError = 'No camera available — you will join with audio only.';
    else if (!stream.getAudioTracks().length) L.mediaError = 'No microphone available — you will join with video only.';
    applyLobbyTrackState();
    await fillDeviceSelects();
    updatePreviewUi();
    startMeter(stream);
  }
  function stopStream(s) { if (s) s.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* ignore */ } }); }
  function applyLobbyTrackState() {
    const L = S.lobby; if (!L || !L.stream) return;
    L.stream.getAudioTracks().forEach(t => { t.enabled = L.mic; });
    L.stream.getVideoTracks().forEach(t => { t.enabled = L.cam; });
  }
  async function fillDeviceSelects() {
    const L = S.lobby; if (!L) return;
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { devs = []; }
    L.devices.cams = devs.filter(d => d.kind === 'videoinput');
    L.devices.mics = devs.filter(d => d.kind === 'audioinput');
    const curCam = L.stream?.getVideoTracks()[0]?.getSettings?.().deviceId || L.camId;
    const curMic = L.stream?.getAudioTracks()[0]?.getSettings?.().deviceId || L.micId;
    const fill = (sel, list, cur, label) => {
      const el = document.getElementById(sel); if (!el) return;
      el.innerHTML = list.length ? list.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''} data-no-i18n>${esc(d.label || `${tr(label)} ${i + 1}`)}</option>`).join('') : `<option value="">${esc(tr('Not available'))}</option>`;
      el.disabled = !list.length;
    };
    fill('lc-cam-select', L.devices.cams, curCam, 'Camera');
    fill('lc-mic-select', L.devices.mics, curMic, 'Microphone');
  }
  function updatePreviewUi() {
    const L = S.lobby; if (!L || S.view !== 'lobby') return;
    const video = document.getElementById('lc-preview-video');
    const hasVideo = !!(L.stream && L.stream.getVideoTracks().length);
    if (video) { if (video.srcObject !== L.stream) video.srcObject = hasVideo ? L.stream : null; video.style.visibility = hasVideo && L.cam ? 'visible' : 'hidden'; }
    const off = document.getElementById('lc-preview-off'); if (off) off.style.display = hasVideo && L.cam ? 'none' : 'flex';
    const offTxt = document.getElementById('lc-preview-off-txt'); if (offTxt) offTxt.textContent = hasVideo ? 'Camera is off' : 'No camera';
    const msg = document.getElementById('lc-media-msg');
    if (msg) {
      msg.innerHTML = L.mediaError ? `<span>${esc(L.mediaError)}</span> <button type="button" class="lc-btn lc-sm" data-lc="retry-media">Try again</button>` : '';
      msg.classList.toggle('show', !!L.mediaError);
    }
    const mb = document.getElementById('lc-lobby-mic'); if (mb) { mb.textContent = L.mic ? '🎙️' : '🔇'; mb.setAttribute('aria-pressed', String(L.mic)); mb.setAttribute('aria-label', tr(L.mic ? 'Turn microphone off' : 'Turn microphone on')); mb.classList.toggle('off', !L.mic); }
    const cb = document.getElementById('lc-lobby-cam'); if (cb) { cb.textContent = L.cam ? '📷' : '🚫'; cb.setAttribute('aria-pressed', String(L.cam)); cb.setAttribute('aria-label', tr(L.cam ? 'Turn camera off' : 'Turn camera on')); cb.classList.toggle('off', !L.cam); }
  }
  // mic level meter (lobby)
  let meter = null;
  function startMeter(stream) {
    stopMeter();
    if (!stream || !stream.getAudioTracks().length) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try {
      const ctx = new AC(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 256; src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      meter = { ctx, raf: 0 };
      const loop = () => {
        if (!meter) return;
        an.getByteTimeDomainData(buf); let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        const bar = document.getElementById('lc-meter-bar');
        if (bar) bar.style.width = (S.lobby && S.lobby.mic ? Math.min(100, peak * 1.6) : 0) + '%';
        meter.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { meter = null; }
  }
  function stopMeter() { if (meter) { cancelAnimationFrame(meter.raf); try { meter.ctx.close(); } catch (e) { /* ignore */ } meter = null; } }

  function afterLobbyRender() { startPreview(); }

  function syncConsentUi() {
    const L = S.lobby; if (!L) return;
    const ai = document.getElementById('lc-c-ai'), st = document.getElementById('lc-c-storage');
    if (!L.consent.recording) { L.consent.ai_analysis = false; L.consent.storage = false; }
    if (ai) { ai.disabled = !L.consent.recording; ai.checked = L.consent.ai_analysis; }
    if (st) { st.disabled = !L.consent.recording; st.checked = L.consent.storage; }
    const g = document.getElementById('lc-guardian'); if (g) g.hidden = !L.minor;
    const sum = document.getElementById('lc-consent-summary'); if (sum) sum.innerHTML = consentSummaryHtml(L);
    const pi = document.getElementById('lc-preview-initials'); if (pi) { pi.textContent = initials(L.name || 'You'); pi.style.background = colorFor(L.name || 'you'); }
  }
  function setLobbyError(msg) {
    const L = S.lobby; if (L) L.error = msg;
    const el = document.getElementById('lc-lobby-err'); if (el) el.textContent = msg ? tr(msg) : '';
  }

  async function joinFromLobby() {
    const L = S.lobby;
    L.name = (document.getElementById('lc-name')?.value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!L.name) { setLobbyError('Please write your name.'); document.getElementById('lc-name')?.focus(); return; }
    const anyConsent = L.consent.recording || L.consent.ai_analysis || L.consent.storage;
    if (L.minor && anyConsent && !guardianOk(L)) {
      if (!L.guardian.name.trim()) { setLobbyError("Please write the guardian's name."); document.getElementById('lc-g-name')?.focus(); return; }
      if (!EMAIL_RE.test(L.guardian.email.trim())) { setLobbyError("Please write a valid guardian email."); document.getElementById('lc-g-email')?.focus(); return; }
      setLobbyError('The guardian must confirm the consent.'); document.getElementById('lc-g-consent')?.focus(); return;
    }
    setLobbyError('');
    const btn = document.getElementById('lc-join'); if (btn) { btn.disabled = true; btn.textContent = tr('Connecting…'); }
    stopMeter();
    await enterRoom();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // ROOM
  // ════════════════════════════════════════════════════════════════════════════════════════
  const roomOwnerKey = () => String(currentUser?.id || 'guest').replace(/-/g, '').slice(0, 12).toLowerCase();
  const randId = () => Math.random().toString(36).slice(2, 10);
  const isNarrow = () => window.matchMedia && window.matchMedia('(max-width: 900px)').matches;

  async function enterRoom() {
    const L = S.lobby;
    let kind = await detectProviderKind();
    const planText = (S.planning && S.planning.content) || (S.sampleKey === 'chemistry' ? SAMPLE_PLAN_ES : SAMPLE_PLAN_EN);
    const plan = parsePlanSections(planText, parseInt(S.planning?.params?.duration, 10) || 45);
    plan.sections.forEach(s => { s.elapsed = 0; });
    const recorded = willBeRecorded(L);
    const R = {
      kind, provider: null, role: L.role, name: L.name, stream: L.stream, screen: null,
      mic: L.mic && !!L.stream?.getAudioTracks().length, cam: L.cam && !!L.stream?.getVideoTracks().length,
      consent: { ...L.consent }, recorded, minor: L.minor, guardianOk: guardianOk(L),
      hand: false, rec: { state: 'off', secs: 0, everOn: false }, secs: 0, remoteScreens: [],
      chat: [], unread: 0, side: isNarrow() ? null : (L.role === 'teacher' ? 'plan' : 'chat'),
      speaking: new Set(), talk: { teacher: 0, students: 0 }, plan, running: -1, participants: [],
      // A calendar session → one room for its teacher and students. TODO(live): api/class/token.js grants
      // roomAdmin by "<ownerKey>-…" rooms; with real LiveKit, look the session up (teacher → admin) instead.
      roomName: S.sessionId ? `sess-${String(S.sessionId).replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`
        : `${roomOwnerKey()}-${S.planning?.id ? String(S.planning.id).replace(/-/g, '').slice(0, 10) : randId()}`,
      endOpen: false,
    };
    const connectOpts = provider => ({
      room: R.roomName, name: R.name, role: R.role, consent: R.consent, recorded, minor: R.minor, guardianOk: R.guardianOk,
      guardian: R.minor ? { name: L.guardian.name.trim(), email: L.guardian.email.trim(), consent: L.guardian.consent } : null,
      localStream: R.stream, mic: R.mic, cam: R.cam, provider, title: S.sessionTitle,
    });
    let provider = createProvider(kind);
    wireProvider(provider, R);
    try {
      await provider.connect(connectOpts(kind));
    } catch (e) {
      console.warn('live-class connect failed', e);
      await provider.disconnect();
      if (kind !== 'livekit') throw e;
      toast('Could not connect to the live classroom — opening the demo instead.', 'err');
      kind = R.kind = 'demo'; provider = createProvider('demo'); wireProvider(provider, R);
      await provider.connect(connectOpts('demo'));
    }
    if (S.lobby !== L) { provider.disconnect(); return; } // user left meanwhile
    R.provider = provider;
    S.room = R; S.lobby = null;
    S.view = 'room';
    render();
    S.timers.push(setInterval(roomTick, 1000));
    if (R.recorded === false && R.role !== 'teacher') toast('You joined without being recorded.', 'ok');
    // Attendance (public/attendance.js): a calendar class records who entered (students: present / late; the teacher too).
    // TODO(live): with real LiveKit, its webhook (participant_joined / left) also feeds attendance_record_external.
    if (S.sessionId && window.TCAttendance) { R.attendance = true; window.TCAttendance.roomJoin(S.sessionId); }
  }

  function wireProvider(p, R) {
    p.on('participants', list => { R.participants = list.slice(); if (S.room === R) { renderGrid(); renderPeople(); updateRoomUi(); } });
    p.on('speaking', set => { R.speaking = set; if (S.room === R) updateTiles(); });
    p.on('chat', m => {
      R.chat.push(m); if (R.chat.length > 200) R.chat.shift();
      if (S.room !== R) return;
      if (R.side !== 'chat' && !m.self) R.unread++;
      renderChat(); updateRoomUi();
    });
    p.on('hand', ({ id, up }) => {
      if (S.room !== R) return;
      if (up && id !== 'local' && R.role === 'teacher') { const who = R.participants.find(x => x.id === id); toast('✋ ' + (who ? who.name : '') + ' — ' + tr('raised a hand')); }
      renderPeople(); updateTiles();
    });
    p.on('recording', state => {
      const was = R.rec.state; R.rec.state = state; if (state === 'on') R.rec.everOn = true;
      if (S.room !== R) return;
      if (R.role !== 'teacher' && was !== state) toast(state === 'on' ? (R.recorded ? 'The teacher started recording. You are being recorded.' : 'The teacher started recording. You are not being recorded.') : state === 'paused' ? 'Recording paused' : 'Recording stopped');
      updateRoomUi();
    });
    p.on('screens', list => {
      const before = R.remoteScreens.map(x => x.id).join('|');
      R.remoteScreens = (list || []).slice();
      if (S.room !== R || R.remoteScreens.map(x => x.id).join('|') === before) return;
      const fresh = R.remoteScreens.filter(x => !before.split('|').includes(x.id));
      fresh.forEach(x => toast('🖥️ ' + x.name + ' — ' + tr('is sharing their screen')));
      renderGrid();
    });
    p.on('disconnected', () => { if (S.room === R && S.view === 'room') { toast('You were disconnected.', 'err'); } });
  }

  function ctl(id, act, icon, label, extra = '') {
    return `<button type="button" class="lc-ctl" id="lc-ctl-${id}" data-lc="${act}" ${extra}><span class="lc-ctl-ic" aria-hidden="true">${icon}</span><span class="lc-ctl-lb">${label}</span></button>`;
  }
  function roomHtml() {
    const R = S.room; const teacher = R.role === 'teacher';
    return `<div class="lc-room${R.side ? ' side-open' : ''}" id="lc-room">
      <div class="lc-room-top">
        <div class="lc-room-title">${demoChip()} <b data-no-i18n>${esc(S.sessionTitle)}</b> <span class="lc-chip" id="lc-provider-chip">${R.kind === 'livekit' ? 'LiveKit' : 'Simulated participants'}</span></div>
        <div class="lc-rec" id="lc-rec" data-state="off"><span class="lc-rec-dot" aria-hidden="true"></span><span class="lc-rec-label" aria-live="polite">Not recording</span><span class="lc-rec-time" data-no-i18n id="lc-rec-time"></span></div>
        <div class="lc-talk" id="lc-talk" role="group" aria-label="${esc(tr('Talk time'))}">
          <span class="lc-talk-lb">Teacher</span> <b data-no-i18n id="lc-talk-t">0%</b>
          <div class="lc-talk-bar" aria-hidden="true"><span id="lc-talk-bar-t"></span></div>
          <b data-no-i18n id="lc-talk-s">0%</b> <span class="lc-talk-lb">Students</span>
        </div>
        <div class="lc-clock" data-no-i18n id="lc-clock" aria-label="${esc(tr('Class time'))}">00:00</div>
      </div>
      ${banner(true)}
      <div class="lc-room-body">
        <div class="lc-stage"><div class="lc-grid" id="lc-grid"></div></div>
        <aside class="lc-side" id="lc-side" aria-label="${esc(tr('Side panel'))}">
          <div class="lc-side-tabs" role="tablist">
            <button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="plan" id="lc-tab-plan">Class plan</button>
            <button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="chat" id="lc-tab-chat">Chat</button>
            <button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="people" id="lc-tab-people">People</button>
            ${S.sessionId && window.TCClassDoc ? '<button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="doc" id="lc-tab-doc">Document</button>' : ''}
            <button type="button" class="lc-side-close" data-lc="side-close" aria-label="${esc(tr('Close panel'))}">✕</button>
          </div>
          <div class="lc-side-body" id="lc-side-plan" role="tabpanel" aria-labelledby="lc-tab-plan">${planPanelHtml()}</div>
          <div class="lc-side-body" id="lc-side-chat" role="tabpanel" aria-labelledby="lc-tab-chat">
            <div class="lc-chat-list" id="lc-chat-list" aria-live="polite"></div>
            <form class="lc-chat-form" id="lc-chat-form" autocomplete="off">
              <label class="lc-sr" for="lc-chat-input">Message</label>
              <input id="lc-chat-input" type="text" maxlength="500" placeholder="Write a message…">
              <button type="submit" class="lc-btn lc-primary lc-sm">Send</button>
            </form>
          </div>
          <div class="lc-side-body" id="lc-side-people" role="tabpanel" aria-labelledby="lc-tab-people"><ul class="lc-people" id="lc-people-list"></ul></div>
          ${S.sessionId && window.TCClassDoc ? '<div class="lc-side-body lc-doc-body" id="lc-side-doc" role="tabpanel" aria-labelledby="lc-tab-doc" hidden></div>' : ''}
        </aside>
      </div>
      <div class="lc-controls" role="toolbar" aria-label="${esc(tr('Class controls'))}">
        <div class="lc-ctl-group">
          ${ctl('mic', 'mic', '🎙️', 'Mute')}
          ${ctl('cam', 'cam', '📷', 'Stop video')}
          ${ctl('share', 'share', '🖥️', 'Share screen')}
          ${ctl('hand', 'hand', '✋', 'Raise hand')}
        </div>
        <div class="lc-ctl-group">
          ${ctl('plan', 'side', '📋', 'Plan', 'data-side="plan"')}
          ${ctl('chat', 'side', '💬', 'Chat', 'data-side="chat"')}
          ${ctl('people', 'side', '👥', 'People', 'data-side="people"')}
          ${S.sessionId && window.TCClassDoc ? ctl('doc', 'side', '📄', 'Document', 'data-side="doc"') : ''}
        </div>
        <div class="lc-ctl-group">
          ${teacher ? ctl('rec', 'rec', '⏺', 'Record') + ctl('pause', 'rec-pause', '⏸', 'Pause') : ''}
          <button type="button" class="lc-ctl lc-end" id="lc-ctl-end" data-lc="${teacher ? 'end' : 'leave'}"><span class="lc-ctl-ic" aria-hidden="true">⏹</span><span class="lc-ctl-lb">${teacher ? 'End class' : 'Leave'}</span></button>
        </div>
      </div>
      <div class="lc-modal-bg" id="lc-end-modal" hidden>
        <div class="lc-modal" role="dialog" aria-modal="true" aria-labelledby="lc-end-h">
          <h2 id="lc-end-h">End the class for everyone?</h2>
          <p>The call ends for all participants. If you recorded, insights are prepared next.</p>
          <div class="lc-modal-actions">
            <button type="button" class="lc-btn" data-lc="end-cancel" id="lc-end-cancel">Cancel</button>
            <button type="button" class="lc-btn lc-danger" data-lc="end-confirm" id="lc-end-confirm">End class</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function afterRoomRender() {
    renderGrid(); renderPeople(); renderChat(); updateRoomUi();
  }

  function consentBadge(p) {
    if (p.recorded) return `<span class="lc-badge rec" title="${esc(tr('Consented to recording'))}">● <span>Recorded</span></span>${p.minor ? ` <span class="lc-badge" title="${esc(tr('Guardian consent'))}">👪 <span>Guardian ✓</span></span>` : ''}`;
    return `<span class="lc-badge off" title="${esc(tr('Attends without recording'))}"><span>Not recorded</span></span>`;
  }
  function tileHtml(p) {
    const R = S.room;
    const remoteVideo = !p.isLocal && R.kind === 'livekit';
    return `<div class="lc-tile" data-pid="${esc(p.id)}" role="group" aria-label="${esc(p.name)}">
      ${p.isLocal ? '<video class="lc-video" id="lc-local-video" autoplay muted playsinline></video>' : remoteVideo ? '<video class="lc-video" autoplay playsinline></video>' : ''}
      ${!p.isLocal && !remoteVideo ? `<div class="lc-sim-cam" aria-hidden="true" style="--c:${colorFor(p.name)}"></div>` : ''}
      <div class="lc-avatar" style="background:${colorFor(p.name)}" aria-hidden="true" data-no-i18n>${esc(initials(p.name))}</div>
      <span class="lc-hand-badge" aria-hidden="true">✋</span>
      <div class="lc-tile-top">${consentBadge(p)}</div>
      <div class="lc-tile-bar">
        <span class="lc-mic-ind" aria-hidden="true"></span>
        <span class="lc-tile-name" data-no-i18n>${esc(p.name)}</span>${p.isLocal ? ' <span class="lc-you">(you)</span>' : ''}
        ${p.role === 'teacher' ? '<span class="lc-chip lc-chip-t">Teacher</span>' : ''}
      </div>
    </div>`;
  }
  function renderGrid() {
    const R = S.room; const g = document.getElementById('lc-grid'); if (!R || !g) return;
    const list = R.participants.length ? R.participants : [{ id: 'local', isLocal: true, name: R.name, role: R.role, mic: R.mic, cam: R.cam, recorded: R.recorded, minor: R.minor }];
    const share = R.screen ? `<div class="lc-tile lc-share-tile" data-pid="screen"><video class="lc-video" id="lc-share-video" autoplay muted playsinline></video><div class="lc-tile-bar"><span aria-hidden="true">🖥️</span> <span>You are presenting</span> <button type="button" class="lc-btn lc-sm" data-lc="share">Stop sharing</button></div></div>` : '';
    const remoteShares = (R.remoteScreens || []).map(sc => `<div class="lc-tile lc-share-tile remote" data-pid="screen-${esc(sc.id)}" role="group" aria-label="${esc(sc.name)}"><video class="lc-video" data-screen="${esc(sc.id)}" autoplay muted playsinline></video><div class="lc-tile-bar"><span aria-hidden="true">🖥️</span> <span data-no-i18n>${esc(sc.name)}</span> <span>is presenting</span></div></div>`).join('');
    g.innerHTML = remoteShares + share + list.map(tileHtml).join('');
    g.dataset.count = String(list.length + (R.screen ? 1 : 0) + (R.remoteScreens || []).length);
    $$('video[data-screen]', g).forEach(v => { try { R.provider?.attachScreen(v.dataset.screen, v); } catch (e) { /* ignore */ } });
    const lv = document.getElementById('lc-local-video'); if (lv && R.stream && R.stream.getVideoTracks().length) lv.srcObject = R.stream;
    const sv = document.getElementById('lc-share-video'); if (sv && R.screen) sv.srcObject = R.screen;
    if (R.kind === 'livekit') $$('.lc-tile[data-pid] video.lc-video', g).forEach(v => { const id = v.closest('.lc-tile').dataset.pid; if (id !== 'local' && !id.startsWith('screen')) R.provider?.attachVideo(id, v); });
    updateTiles();
  }
  function updateTiles() {
    const R = S.room; const g = document.getElementById('lc-grid'); if (!R || !g) return;
    R.participants.forEach(p => {
      const el = g.querySelector(`.lc-tile[data-pid="${CSS.escape(p.id)}"]`); if (!el) return;
      const camOn = p.isLocal ? (R.cam && !!R.stream?.getVideoTracks().length) : p.cam;
      el.classList.toggle('speaking', R.speaking.has(p.id) && (p.isLocal ? R.mic : p.mic));
      el.classList.toggle('cam-off', !camOn);
      el.classList.toggle('muted', !(p.isLocal ? R.mic : p.mic));
      el.classList.toggle('hand', !!p.hand);
      const mi = el.querySelector('.lc-mic-ind'); if (mi) mi.textContent = (p.isLocal ? R.mic : p.mic) ? '🎙️' : '🔇';
    });
  }

  function renderPeople() {
    const R = S.room; const ul = document.getElementById('lc-people-list'); if (!R || !ul) return;
    const teacher = R.role === 'teacher';
    const list = R.participants.slice().sort((a, b) => (b.hand - a.hand) || (a.role === 'teacher' ? -1 : 0));
    const recCount = list.filter(p => p.recorded).length;
    ul.innerHTML = `<li class="lc-people-sum"><span data-no-i18n>${list.length}</span> <span>participants</span> · <span data-no-i18n>${recCount}</span> <span>recorded</span></li>` + list.map(p => `<li class="lc-person">
      <div class="lc-avatar sm" style="background:${colorFor(p.name)}" aria-hidden="true" data-no-i18n>${esc(initials(p.name))}</div>
      <div class="lc-person-main"><div><span class="lc-person-name" data-no-i18n>${esc(p.name)}</span>${p.isLocal ? ' <span class="lc-you">(you)</span>' : ''}</div>
        <div class="lc-person-meta"><span>${p.role === 'teacher' ? 'Teacher' : 'Student'}</span> ${consentBadge(p)}</div></div>
      <div class="lc-person-state">${p.hand ? `<span class="lc-hand-on" title="${esc(tr('Hand raised'))}">✋</span>` : ''}<span aria-label="${esc(tr(p.mic ? 'Microphone on' : 'Microphone off'))}">${p.mic ? '🎙️' : '🔇'}</span><span aria-label="${esc(tr(p.cam ? 'Camera on' : 'Camera off'))}">${p.cam ? '📷' : '🚫'}</span>
      ${teacher && !p.isLocal && p.hand ? `<button type="button" class="lc-btn lc-sm" data-lc="lower-hand" data-id="${esc(p.id)}">Lower hand</button>` : ''}
      ${teacher && !p.isLocal && p.mic && R.kind === 'demo' ? `<button type="button" class="lc-btn lc-sm" data-lc="mute-p" data-id="${esc(p.id)}">Mute</button>` : ''}</div>
    </li>`).join('');
  }

  function renderChat() {
    const R = S.room; const box = document.getElementById('lc-chat-list'); if (!R || !box) return;
    box.innerHTML = R.chat.length ? R.chat.map(m => `<div class="lc-msg${m.self ? ' self' : ''}"><div class="lc-msg-head"><b data-no-i18n>${esc(m.self ? R.name : m.name)}</b> <span data-no-i18n>${esc(new Date(m.ts).toLocaleTimeString(typeof uiLocale === 'function' ? uiLocale() : undefined, { hour: '2-digit', minute: '2-digit' }))}</span></div><div class="lc-msg-text" data-no-i18n>${esc(m.text)}</div></div>`).join('')
      : '<p class="lc-empty">No messages yet. Messages are visible to everyone in the class.</p>';
    box.scrollTop = box.scrollHeight;
  }

  function planPanelHtml() {
    const R = S.room; const P = R.plan;
    const total = P.sections.reduce((n, s) => n + s.minutes, 0);
    return `<div class="lc-plan">
      <div class="lc-plan-head">
        <div class="lc-plan-title" data-no-i18n>${esc(P.title || S.sessionTitle)}</div>
        <div class="lc-plan-total"><span>Planned</span> <b data-no-i18n>${total} min</b> · <span>Activities</span> <b data-no-i18n>${P.sections.length}</b></div>
        ${S.planning ? '' : '<div class="lc-hint">Sample plan — open a saved class to see yours here.</div>'}
      </div>
      ${P.intro ? `<details class="lc-plan-intro"><summary>Objectives and notes</summary><div class="cls-doc lc-plan-doc">${formatDoc('\n' + P.intro)}</div></details>` : ''}
      <ol class="lc-secs">${P.sections.map((s, i) => `<li class="lc-sec" id="lc-sec-${i}">
        <div class="lc-sec-head"><span class="lc-sec-title" data-no-i18n>${s.generic ? '' : esc(s.title)}</span>${s.generic ? '<span class="lc-sec-title">Whole class</span>' : ''}<span class="lc-sec-planned" data-no-i18n>${s.minutes} min</span></div>
        <div class="lc-sec-timer">
          <span class="lc-sec-time" id="lc-sec-time-${i}" data-no-i18n>00:00 / ${pad2(s.minutes)}:00</span>
          <div class="lc-progress" aria-hidden="true"><span id="lc-sec-bar-${i}"></span></div>
          <button type="button" class="lc-btn lc-sm" data-lc="sec-toggle" data-i="${i}" id="lc-sec-btn-${i}">▶ Start</button>
          <button type="button" class="lc-btn lc-sm lc-icon" data-lc="sec-reset" data-i="${i}" aria-label="${esc(tr('Reset timer'))}">↺</button>
        </div>
        ${s.body.join('').trim() ? `<details class="lc-sec-details"><summary>Details</summary><div class="cls-doc lc-plan-doc">${formatDoc('\n' + s.body.join('\n'))}</div></details>` : ''}
      </li>`).join('')}</ol>
      <button type="button" class="lc-btn lc-next" data-lc="sec-next" id="lc-sec-next">Next activity ⏭</button>
    </div>`;
  }

  function updateRoomUi() {
    const R = S.room; if (!R || S.view !== 'room') return;
    const room = document.getElementById('lc-room'); if (!room) return;
    room.classList.toggle('side-open', !!R.side);
    room.classList.toggle('doc-open', R.side === 'doc');
    // side panel tabs
    ['plan', 'chat', 'people', 'doc'].forEach(k => {
      const tab = document.getElementById('lc-tab-' + k); const body = document.getElementById('lc-side-' + k); const c = document.getElementById('lc-ctl-' + k);
      if (tab) { tab.setAttribute('aria-selected', String(R.side === k)); tab.classList.toggle('active', R.side === k); tab.tabIndex = R.side === k ? 0 : -1; }
      if (body) body.hidden = R.side !== k;
      if (c) { c.setAttribute('aria-pressed', String(R.side === k)); c.classList.toggle('on', R.side === k); }
    });
    const chatBtn = document.getElementById('lc-ctl-chat');
    if (chatBtn) { let b = chatBtn.querySelector('.lc-unread'); if (R.unread && !b) { b = document.createElement('span'); b.className = 'lc-unread'; b.setAttribute('data-no-i18n', ''); chatBtn.appendChild(b); } if (b) { if (R.unread) b.textContent = String(R.unread); else b.remove(); } }
    // controls
    const setCtl = (id, pressed, icon, label, offCls) => {
      const b = document.getElementById('lc-ctl-' + id); if (!b) return;
      b.setAttribute('aria-pressed', String(pressed));
      b.classList.toggle('off', !!offCls);
      const ic = b.querySelector('.lc-ctl-ic'); if (ic && ic.textContent !== icon) ic.textContent = icon;
      const lb = b.querySelector('.lc-ctl-lb'); if (lb && lb.dataset.k !== label) { lb.dataset.k = label; lb.textContent = label; }
    };
    const hasA = !!R.stream?.getAudioTracks().length, hasV = !!R.stream?.getVideoTracks().length;
    setCtl('mic', !R.mic, R.mic ? '🎙️' : '🔇', R.mic ? 'Mute' : 'Unmute', !R.mic);
    setCtl('cam', !R.cam, R.cam ? '📷' : '🚫', R.cam ? 'Stop video' : 'Start video', !R.cam);
    const micB = document.getElementById('lc-ctl-mic'); if (micB) micB.disabled = !hasA;
    const camB = document.getElementById('lc-ctl-cam'); if (camB) camB.disabled = !hasV;
    setCtl('share', !!R.screen, '🖥️', R.screen ? 'Stop sharing' : 'Share screen', false);
    setCtl('hand', R.hand, '✋', R.hand ? 'Lower hand' : 'Raise hand', false);
    document.getElementById('lc-ctl-hand')?.classList.toggle('on', R.hand);
    document.getElementById('lc-ctl-share')?.classList.toggle('on', !!R.screen);
    const st = R.rec.state;
    setCtl('rec', st !== 'off', '⏺', st === 'off' ? 'Record' : 'Stop recording', false);
    document.getElementById('lc-ctl-rec')?.classList.toggle('rec-on', st !== 'off');
    const pb = document.getElementById('lc-ctl-pause');
    if (pb) { pb.hidden = st === 'off'; setCtl('pause', st === 'paused', st === 'paused' ? '▶' : '⏸', st === 'paused' ? 'Resume' : 'Pause', false); }
    // REC indicator
    const rec = document.getElementById('lc-rec');
    if (rec) {
      rec.dataset.state = st;
      const lb = rec.querySelector('.lc-rec-label'); const k = st === 'on' ? 'REC' : st === 'paused' ? 'REC paused' : 'Not recording';
      if (lb.dataset.k !== k) { lb.dataset.k = k; lb.textContent = k; }
      const t = document.getElementById('lc-rec-time'); if (t) t.textContent = st === 'off' && !R.rec.secs ? '' : mmss(R.rec.secs);
    }
    // talk meter
    const tot = R.talk.teacher + R.talk.students;
    const tp = tot ? Math.round(R.talk.teacher / tot * 100) : 0; const sp = tot ? 100 - tp : 0;
    const set = (id, v) => { const e = document.getElementById(id); if (e && e.textContent !== v) e.textContent = v; };
    set('lc-talk-t', tp + '%'); set('lc-talk-s', sp + '%');
    const bar = document.getElementById('lc-talk-bar-t'); if (bar) bar.style.width = (tot ? tp : 50) + '%';
    const talk = document.getElementById('lc-talk'); if (talk) talk.title = `${tr('Teacher')} ${mmss(R.talk.teacher)} · ${tr('Students')} ${mmss(R.talk.students)}`;
    set('lc-clock', mmss(R.secs));
    // plan timers
    R.plan.sections.forEach((s, i) => {
      const over = s.elapsed > s.minutes * 60;
      set('lc-sec-time-' + i, `${mmss(s.elapsed)} / ${pad2(s.minutes)}:00`);
      const b = document.getElementById('lc-sec-bar-' + i); if (b) b.style.width = Math.min(100, s.elapsed / (s.minutes * 60) * 100) + '%';
      const li = document.getElementById('lc-sec-' + i); if (li) { li.classList.toggle('running', R.running === i); li.classList.toggle('over', over); li.classList.toggle('done', s.elapsed > 0 && R.running !== i); }
      const btn = document.getElementById('lc-sec-btn-' + i); if (btn) { const k = R.running === i ? '⏸ Pause' : s.elapsed ? '▶ Resume' : '▶ Start'; if (btn.dataset.k !== k) { btn.dataset.k = k; btn.textContent = k; } }
    });
  }

  function roomTick() {
    const R = S.room; if (!R) return;
    if (!currentUser) { teardownRoom(); S.view = 'home'; return; }
    R.secs++;
    if (R.rec.state === 'on') R.rec.secs++;
    const speakers = R.participants.filter(p => R.speaking.has(p.id) && (p.isLocal ? R.mic : p.mic));
    if (speakers.some(p => p.role === 'teacher')) R.talk.teacher++;
    else if (speakers.length) R.talk.students++;
    if (R.running >= 0) R.plan.sections[R.running].elapsed++;
    updateRoomUi();
  }

  async function toggleMic() {
    const R = S.room; if (!R.stream?.getAudioTracks().length) return;
    R.mic = !R.mic; R.stream.getAudioTracks().forEach(t => { t.enabled = R.mic; });
    try { await R.provider.setMicrophoneEnabled(R.mic); } catch (e) { console.warn(e); }
    updateRoomUi(); updateTiles();
  }
  async function toggleCam() {
    const R = S.room; if (!R.stream?.getVideoTracks().length) return;
    R.cam = !R.cam; R.stream.getVideoTracks().forEach(t => { t.enabled = R.cam; });
    try { await R.provider.setCameraEnabled(R.cam); } catch (e) { console.warn(e); }
    updateRoomUi(); updateTiles();
  }
  async function toggleShare() {
    const R = S.room;
    if (R.screen) { stopShare(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('Screen sharing is not available in this browser.', 'err'); return; }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (S.room !== R) { stopStream(s); return; }
      R.screen = s;
      s.getVideoTracks().forEach(t => { t.onended = () => { if (S.room === R && R.screen === s) stopShare(); }; });
      try { await R.provider.startScreenShare(s); } catch (e) { console.warn(e); }
      renderGrid(); updateRoomUi();
      toast(R.kind === 'livekit' ? 'You are sharing your screen with the class.' : 'You are sharing your screen (demo: only you can see it).', 'ok');
    } catch (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') console.warn('share', e);
      toast('Screen sharing was cancelled.');
    }
  }
  function stopShare() {
    const R = S.room; if (!R || !R.screen) return;
    stopStream(R.screen); R.screen = null;
    try { R.provider.stopScreenShare(); } catch (e) { /* ignore */ }
    renderGrid(); updateRoomUi();
  }
  async function toggleRec() {
    const R = S.room; if (R.role !== 'teacher') return;
    const next = R.rec.state === 'off' ? 'on' : 'off';
    await R.provider.setRecording(next);
    const rc = R.participants.filter(p => p.recorded).length;
    if (next === 'on') toast(`${tr('Recording started')} — ${rc}/${R.participants.length} ${tr('participants consented')}`, 'ok');
    else toast('Recording stopped');
    updateRoomUi();
  }
  async function togglePause() {
    const R = S.room; if (R.role !== 'teacher' || R.rec.state === 'off') return;
    await R.provider.setRecording(R.rec.state === 'paused' ? 'on' : 'paused');
    toast(R.rec.state === 'paused' ? 'Recording paused' : 'Recording resumed');
    updateRoomUi();
  }
  function setSide(k) {
    const R = S.room; R.side = R.side === k && document.activeElement?.closest('.lc-controls') ? null : k;
    if (R.side === 'chat') { R.unread = 0; renderChat(); setTimeout(() => document.getElementById('lc-chat-input')?.focus(), 30); }
    updateRoomUi();
    // the shared class document (public/class-doc.js), mounted the first time the tab opens; it keeps syncing while in the room
    if (R.side === 'doc' && !R.doc && S.sessionId && window.TCClassDoc) {
      const host = document.getElementById('lc-side-doc');
      if (host) { R.doc = 'loading'; window.TCClassDoc.mount(host, S.sessionId).then(v => { if (S.room === R) R.doc = v; else if (v) v.destroy(); }); }
    }
  }
  function secToggle(i) {
    const R = S.room; R.running = R.running === i ? -1 : i; updateRoomUi();
  }
  function secNext() {
    const R = S.room; const n = R.plan.sections.length;
    const from = R.running >= 0 ? R.running : R.plan.sections.findIndex(s => s.elapsed === 0) - 1;
    const next = Math.min(n - 1, from + 1);
    R.running = next; updateRoomUi();
    document.getElementById('lc-sec-' + next)?.scrollIntoView({ block: 'nearest' });
  }

  function openEndModal() {
    const m = document.getElementById('lc-end-modal'); if (!m) return;
    m.hidden = false; S.room.endOpen = true; S.room.lastFocus = document.activeElement;
    document.getElementById('lc-end-cancel')?.focus();
    setTimeout(() => { if (S.room?.endOpen && !m.contains(document.activeElement)) document.getElementById('lc-end-cancel')?.focus(); }, 20);
  }
  function closeEndModal() {
    const m = document.getElementById('lc-end-modal'); if (m) m.hidden = true;
    if (S.room) { S.room.endOpen = false; try { S.room.lastFocus?.focus(); } catch (e) { /* ignore */ } }
  }

  function teardownRoom() {
    const R = S.room; if (!R) return;
    if (R.doc && R.doc !== 'loading') { try { R.doc.close(); } catch (e) { /* ignore */ } }
    if (window.TCAttendance && R.attendance) window.TCAttendance.roomLeave();
    clearViewTimers();
    stopStream(R.stream); stopStream(R.screen);
    try { R.provider && R.provider.disconnect(); } catch (e) { /* ignore */ }
    S.room = null;
  }
  function teardownLobby() {
    stopMeter();
    if (S.lobby) { stopStream(S.lobby.stream); S.lobby.stream = null; }
  }

  function endClass() {
    const R = S.room; if (!R) return;
    const summary = {
      recorded: R.rec.everOn, recSecs: R.rec.secs, secs: R.secs, participants: R.participants.length,
      recordedCount: R.participants.filter(p => p.recorded).length, talk: { ...R.talk }, role: R.role,
      plan: R.plan.sections.map(s => ({ title: s.generic ? '' : s.title, planned: s.minutes, actual: Math.round(s.elapsed / 60) })),
    };
    const sess = S.sessionId && R.role === 'teacher' && S.sessionRole !== 'student' ? { id: S.sessionId, title: S.sessionTitle, group: S.sessionGroup } : null;
    teardownRoom();
    // the class document keeps a "class end" version (teacher / substitute; nothing is created if nobody wrote)
    if (sess && typeof sb !== 'undefined') sb.rpc('classdoc_add_version', { p_session: sess.id, p_label: 'class_end' }).then(() => {}, () => {});
    S.processing = summary;
    S.insights = { tab: 'student', student: 0, sub: 'overview', role: summary.role, live: summary, liveSample: S.sampleKey, saved: null, saving: !!sess };
    S.view = 'processing'; render(); runProcessing();
    if (sess) saveDemoInsights(sess);
  }

  // A calendar class ended by its teacher / substitute: store demo insights for it (idempotent; the database
  // checks the caller teaches that class). Nothing is stored for the free "Start live class" demo or in View as.
  async function saveDemoInsights(sess) {
    const I = S.insights;
    try {
      if (typeof viewAs !== 'undefined' && viewAs) throw new Error('view as');
      const payload = V.buildDemoPayload({ key: S.sampleKey, title: sess.title, group: sess.group });
      const { error } = await sb.rpc('generate_demo_insights', { p_session: sess.id, p_payload: payload });
      if (error) throw error;
      I.saved = { id: sess.id };
    } catch (e) { if (!(e && e.message === 'view as')) console.warn('demo insights not saved', e); }
    I.saving = false;
    if (S.insights !== I) return;
    if (I.saved && S.view === 'insights') rerenderInsights(); // offer "Open in Insights" (no jump while reading)
  }
  // After "processing": the stored insights of the class (Insights panel) when they were saved; otherwise the sample.
  function finishProcessing() {
    const I = S.insights; I.finished = true;
    if (I.saved && window.TCInsightsPanel) { openSavedInsights(I.saved.id); return; }
    S.view = 'insights'; render();
  }
  function openSavedInsights(id) {
    if (!window.TCInsightsPanel) return;
    S.view = 'home';
    window.TCInsightsPanel.openSession(id, { from: 'live' });
    toast('Demo insights saved for this class.', 'ok');
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // PROCESSING (simulated pipeline: audio → Azure Speech → GPT-4o)
  // ════════════════════════════════════════════════════════════════════════════════════════
  const PROC_STEPS = [
    { title: 'Saving audio', sub: 'Only the voices of participants who consented', ms: 1200 },
    { title: 'Transcribing', sub: 'Speech to text, one track per microphone', ms: 1400 },
    { title: 'Analyzing', sub: 'Student progress and teacher observation', ms: 1400 },
  ];
  function processingHtml() {
    const P = S.processing || {};
    return `<div class="lc-wrap lc-processing">
      ${banner()}
      <header class="lc-head"><div><h1>Preparing your class insights</h1><p class="lc-sub" data-no-i18n>${esc(S.sessionTitle)}</p></div>${demoChip()}</header>
      <section class="lc-card">
        <p class="lc-proc-summary">${P.recorded
          ? `<span>Recorded</span> <b data-no-i18n>${mmss(P.recSecs)}</b> · <b data-no-i18n>${P.recordedCount}/${P.participants}</b> <span>participants consented</span>`
          : '<span>Nothing was recorded in this demo — the insights below use sample data.</span>'}</p>
        <ol class="lc-proc" id="lc-proc">${PROC_STEPS.map((s, i) => `<li class="lc-proc-step" id="lc-proc-${i}" data-state="wait">
          <span class="lc-proc-ic" aria-hidden="true"></span>
          <div class="lc-proc-main"><b>${s.title}</b><span class="lc-proc-sub">${s.sub}</span><div class="lc-progress"><span id="lc-proc-bar-${i}"></span></div></div>
          <span class="lc-proc-pct" id="lc-proc-pct-${i}" data-no-i18n>0%</span></li>`).join('')}</ol>
        <p class="lc-fine">In the real classroom this takes a few minutes after class; you'll be notified when the insights are ready.</p>
        <button type="button" class="lc-link" data-lc="skip-processing">Skip</button>
      </section>
    </div>`;
  }
  function runProcessing() {
    let i = 0; let t = 0;
    const tick = 80;
    const iv = setInterval(() => {
      if (S.view !== 'processing') { clearInterval(iv); return; }
      const step = PROC_STEPS[i]; t += tick;
      const pct = Math.min(100, Math.round(t / step.ms * 100));
      const li = document.getElementById('lc-proc-' + i);
      if (li) li.dataset.state = 'run';
      const bar = document.getElementById('lc-proc-bar-' + i); if (bar) bar.style.width = pct + '%';
      const pc = document.getElementById('lc-proc-pct-' + i); if (pc) pc.textContent = pct + '%';
      if (pct >= 100) {
        if (li) li.dataset.state = 'done';
        i++; t = 0;
        if (i >= PROC_STEPS.length) { clearInterval(iv); S.timers.push(setTimeout(() => { if (S.view === 'processing') finishProcessing(); }, 350)); }
      }
    }, tick);
    S.timers.push(iv);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // INSIGHTS
  // ════════════════════════════════════════════════════════════════════════════════════════
  // The live-class demo shows the SAMPLE insights, rendered by the shared view (public/insights-view.js).
  // A class from the calendar ended by its teacher / substitute is also stored as demo insights for that
  // class (generate_demo_insights) and then opened in Insights (see endClass / finishProcessing).
  const SUBKEYS = V.SUBTABS.map(([k]) => k);

  function insightsHtml() {
    const X = V.sampleModel(S.sampleKey);
    const I = S.insights;
    const showTeacher = I.role === 'teacher';
    if (!showTeacher) I.tab = 'student';
    const live = I.live && I.liveSample === S.sampleKey ? I.live : null;
    return `<div class="lc-wrap lc-insights">
      ${banner()}
      <button type="button" class="lc-link" data-lc="back-home">${studentBack() ? '← Back to my classes' : '← Back to live classes'}</button>
      <header class="lc-head">
        <div><h1>Class insights</h1>
          <p class="lc-sub"><span data-no-i18n>${esc(live ? S.sessionTitle : X.title)}</span> · <span data-no-i18n>${esc(X.subject)}</span> · <span data-no-i18n>${live ? Math.max(1, Math.round(live.secs / 60)) : X.durationMin} min</span></p></div>
        <div class="lc-sample-switch" role="group" aria-label="${esc(tr('Sample'))}">
          <span class="lc-fine">Sample:</span>
          <button type="button" class="lc-btn lc-sm${S.sampleKey === 'language' ? ' active' : ''}" data-lc="sample" data-k="language" aria-pressed="${S.sampleKey === 'language'}">Language class (EN)</button>
          <button type="button" class="lc-btn lc-sm${S.sampleKey === 'chemistry' ? ' active' : ''}" data-lc="sample" data-k="chemistry" aria-pressed="${S.sampleKey === 'chemistry'}">Chemistry (ES)</button>
        </div>
      </header>
      ${S.insights.saved ? `<div class="ins-saved-note" role="status"><span aria-hidden="true">💡</span> <span>Demo insights saved for this class.</span> <button type="button" class="lc-btn lc-sm" data-lc="open-saved">Open in Insights</button></div>` : ''}
      <div class="lc-tabs" role="tablist" aria-label="${esc(tr('Insights'))}">
        <button type="button" role="tab" class="lc-tab${I.tab === 'student' ? ' active' : ''}" aria-selected="${I.tab === 'student'}" data-lc="ins-tab" data-k="student" id="lc-ins-student">🎒 <span>Student insights</span></button>
        ${showTeacher ? `<button type="button" role="tab" class="lc-tab${I.tab === 'teacher' ? ' active' : ''}" aria-selected="${I.tab === 'teacher'}" data-lc="ins-tab" data-k="teacher" id="lc-ins-teacher">👩‍🏫 <span>Teacher insights</span></button>` : ''}
      </div>
      <div class="lc-ins-body" role="tabpanel">${I.tab === 'teacher' && showTeacher ? teacherInsightsHtml(X, live) : studentInsightsHtml(X)}</div>
    </div>`;
  }

  function studentInsightsHtml(X) {
    const I = S.insights;
    const idx = Math.min(I.student, X.students.length - 1);
    const key = `${X.key}:${idx}`;
    return V.studentTabsHtml(X, idx, I.sub, { P: 'lc', msg: { mode: 'demo', text: S.messages[key] || '', key } });
  }

  function demoReflection(X) { return S.reflections[X.key] || (S.reflections[X.key] = { ...X.teacher.form, reflection: '' }); }
  function teacherInsightsHtml(X, live) {
    const refl = demoReflection(X);
    let date = ''; try { date = new Date().toLocaleDateString(typeof uiLocale === 'function' ? uiLocale() : undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { /* ignore */ }
    return V.teacherReportHtml(X, {
      P: 'lc',
      header: { teacher: (currentUser && currentUser.name) || '', group: X.subject, date,
        students: X.participants, duration: live ? Math.max(1, Math.round(live.secs / 60)) : X.durationMin },
      live: live && live.secs > 5 ? `<span>From your demo session:</span> <span>Teacher</span> <b data-no-i18n>${mmss(live.talk.teacher)}</b> · <span>Students</span> <b data-no-i18n>${mmss(live.talk.students)}</b> · <span>Recorded</span> <b data-no-i18n>${mmss(live.recSecs)}</b>` : '',
      fields: { editable: true, values: refl },
      reflection: { mode: 'edit', text: refl.reflection, demo: true },
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // NAVIGATION + EVENTS
  // ════════════════════════════════════════════════════════════════════════════════════════
  function goLobby() {
    teardownLobby();
    S.lobby = newLobby();
    S.view = 'lobby';
    render();
  }

  function openLiveClass() {
    if (typeof showPanel === 'function') showPanel('live');
    if (S.view === 'room') { if (!document.getElementById('lc-room')) render(); return; }
    if (S.view === 'processing') return;
    render();
  }

  function planningFromDoc() {
    const cr = (typeof currentResult !== 'undefined') ? currentResult : null;
    if (!cr) return null;
    const doc = document.getElementById('lp-doc');
    return { id: cr.id || null, title: cr.title || '', content: ((doc && doc.innerText) || cr.text || '').trim(), params: cr.params || {} };
  }
  // Join a scheduled session from the calendar / student dashboard: {id, title, planning?}
  function openSession(sess) {
    if (S.room) { toast('A live class is already in progress.', 'err'); openLiveClass(); return; }
    const p = sess && sess.planning ? sess.planning : null;
    S.planning = p; S.sessionId = (sess && sess.id) || null;
    // role in THIS class (calendar row): a teacher enrolled in someone else's group joins as a student
    S.sessionRole = sess && (sess.role === 'teacher' || sess.role === 'student') ? sess.role : null;
    S.sessionGroup = (sess && sess.group) || '';
    S.sampleKey = pickSampleKey(p || { title: [(sess && sess.title) || '', S.sessionGroup].join(' '), params: {} });
    S.sessionTitle = (sess && sess.title) || 'Live class';
    if (typeof showPanel === 'function') showPanel('live');
    goLobby();
  }
  const studentBack = () => !!(window.GC && typeof window.GC.isStudentMode === 'function' && window.GC.isStudentMode());
  function openFromDoc() {
    if (S.room) { toast('A live class is already in progress.', 'err'); openLiveClass(); return; }
    const p = planningFromDoc(); if (!p) return;
    S.sessionId = null; S.sessionRole = null;
    S.planning = p; S.sampleKey = pickSampleKey(p);
    S.sessionTitle = p.title || (p.content.split('\n')[0] || '').trim() || 'Live class';
    if (typeof showPanel === 'function') showPanel('live');
    goLobby();
  }
  // Called by index.html when a class document is shown: adds "▶ Start live class".
  function onDocShown() {
    const bar = document.querySelector('#ai-output .cls-doc-actions'); if (!bar || document.getElementById('btn-live-class')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn-out'; b.id = 'btn-live-class'; b.textContent = '▶ Start live class';
    b.addEventListener('click', openFromDoc);
    const save = document.getElementById('btn-save');
    if (save && save.parentNode === bar) bar.insertBefore(b, save); else bar.appendChild(b);
  }

  async function onClick(e) {
    const el = e.target.closest('[data-lc]'); if (!el || !root()?.contains(el)) return;
    const a = el.dataset.lc; const i = parseInt(el.dataset.i, 10);
    const R = S.room;
    switch (a) {
      case 'start': {
        const id = document.getElementById('lc-plan-select')?.value || '';
        const p = id && Array.isArray(plannings) ? plannings.find(x => String(x.id) === id) : null;
        S.planning = p ? { id: p.id, title: p.title, content: p.content, params: p.params || {} } : null;
        S.sessionId = null;
        S.sampleKey = p ? pickSampleKey(p) : 'language';
        S.sessionTitle = p ? (p.title || 'Live class') : SAMPLES.language.title;
        goLobby(); break;
      }
      case 'join-upcoming': {
        const s = demoSessions().upcoming[i]; if (!s) break;
        S.planning = null; S.sessionId = null; S.sampleKey = s.sample; S.sessionTitle = s.title; goLobby(); break;
      }
      case 'past-insights': {
        const s = demoSessions().past[i]; if (!s) break;
        S.sampleKey = s.sample; S.sessionTitle = s.title;
        S.insights = { tab: 'student', student: 0, sub: 'overview', role: 'teacher', live: null };
        S.view = 'insights'; render(); break;
      }
      case 'back-home':
        teardownLobby(); S.lobby = null; S.view = 'home';
        if (studentBack()) { window.GC.backFromLive(); break; } // students: back to their dashboard
        render(); break;
      case 'lobby-mic': S.lobby.mic = !S.lobby.mic; applyLobbyTrackState(); updatePreviewUi(); break;
      case 'lobby-cam': S.lobby.cam = !S.lobby.cam; applyLobbyTrackState(); updatePreviewUi(); break;
      case 'retry-media': S.lobby.camId = ''; S.lobby.micId = ''; startPreview(); break;
      case 'join':
        el.disabled = true;
        try { await joinFromLobby(); } catch (err) { console.warn(err); setLobbyError('Could not join the class.'); }
        finally { const j = document.getElementById('lc-join'); if (j) { j.disabled = false; j.textContent = tr('Join class'); } }
        break;
      case 'mic': if (R) toggleMic(); break;
      case 'cam': if (R) toggleCam(); break;
      case 'share': if (R) toggleShare(); break;
      case 'hand': if (R) { R.hand = !R.hand; await R.provider.setHandRaised(R.hand); updateRoomUi(); } break;
      case 'side': if (R) setSide(el.dataset.side); break;
      case 'side-close': if (R) { R.side = null; updateRoomUi(); } break;
      case 'rec': if (R) toggleRec(); break;
      case 'rec-pause': if (R) togglePause(); break;
      case 'end': openEndModal(); break;
      case 'end-cancel': closeEndModal(); break;
      case 'end-confirm': case 'leave': endClass(); break;
      case 'sec-toggle': if (R) secToggle(i); break;
      case 'sec-reset': if (R) { R.plan.sections[i].elapsed = 0; if (R.running === i) R.running = -1; updateRoomUi(); } break;
      case 'sec-next': if (R) secNext(); break;
      case 'lower-hand': if (R && R.provider._setHand) R.provider._setHand(el.dataset.id, false); break;
      case 'mute-p': if (R && R.provider.muteRemote) R.provider.muteRemote(el.dataset.id); break;
      case 'skip-processing': clearViewTimers(); finishProcessing(); break;
      case 'open-saved': if (S.insights.saved) openSavedInsights(S.insights.saved.id); break;
      case 'sample': S.sampleKey = el.dataset.k === 'chemistry' ? 'chemistry' : 'language'; S.insights.student = 0; render(); break;
      case 'ins-tab': S.insights.tab = el.dataset.k === 'teacher' ? 'teacher' : 'student'; rerenderInsights(`#lc-ins-${S.insights.tab}`); break;
      case 'ins-sub': S.insights.sub = SUBKEYS.includes(el.dataset.k) ? el.dataset.k : 'overview'; rerenderInsights(`#lc-sub-${S.insights.sub}`); break;
      case 'pick-student': S.insights.student = i || 0; rerenderInsights(`.lc-person-chip[data-i="${i || 0}"]`); break;
      case 'draft-msg': {
        const X = V.sampleModel(S.sampleKey); const st = X.students[S.insights.student] || X.students[0];
        const ta = root().querySelector('#lc-teacher-msg'); if (!ta) break;
        ta.value = V.draftMessage(X, st); S.messages[ta.dataset.key] = ta.value; ta.focus();
        toast('Draft ready — edit it before sending.', 'ok'); break;
      }
      case 'send-msg': {
        const ta = root().querySelector('#lc-teacher-msg');
        if (!ta || !ta.value.trim()) { toast('Write a message first.', 'err'); break; }
        toast('Demo: the message was not sent. In the real classroom the student sees it with their insights.', 'ok'); break;
      }
      case 'save-reflection': toast('Reflection saved in this browser tab (demo).', 'ok'); break;
      default: break;
    }
  }
  function rerenderInsights(focusSel) {
    const el = root(); if (!el) return;
    const y = el.scrollTop;
    el.innerHTML = insightsHtml(); el.scrollTop = y;
    const f = focusSel && el.querySelector(focusSel); if (f) f.focus();
  }

  function onInput(e) {
    const t = e.target; if (!root()?.contains(t)) return;
    const L = S.lobby;
    if (L) {
      if (L.error && /^lc-(name|g-name|g-email)$/.test(t.id)) setLobbyError('');
      if (t.id === 'lc-name') { L.name = t.value; syncConsentUi(); }
      else if (t.id === 'lc-g-name') { L.guardian.name = t.value; syncConsentUi(); }
      else if (t.id === 'lc-g-email') { L.guardian.email = t.value; syncConsentUi(); }
    }
    if (t.id === 'lc-teacher-msg') S.messages[t.dataset.key] = t.value;
    if (t.dataset.refl) demoReflection(V.sampleModel(S.sampleKey))[t.dataset.refl] = t.value;
  }
  function onChange(e) {
    const t = e.target; if (!root()?.contains(t)) return;
    const L = S.lobby;
    if (L) {
      if (t.id === 'lc-cam-select') { L.camId = t.value; startPreview(); return; }
      if (t.id === 'lc-mic-select') { L.micId = t.value; startPreview(); return; }
      if (t.name === 'lc-role') { L.role = t.value === 'student' ? 'student' : 'teacher'; return; }
      if (t.id === 'lc-c-recording') L.consent.recording = t.checked;
      if (t.id === 'lc-c-ai') L.consent.ai_analysis = t.checked;
      if (t.id === 'lc-c-storage') L.consent.storage = t.checked;
      if (t.id === 'lc-minor') L.minor = t.checked;
      if (t.id === 'lc-g-consent') L.guardian.consent = t.checked;
      if (L.error) setLobbyError('');
      syncConsentUi();
    }
  }
  function onSubmit(e) {
    if (e.target.id !== 'lc-chat-form') return;
    e.preventDefault();
    const R = S.room; const inp = document.getElementById('lc-chat-input');
    const text = (inp?.value || '').trim().slice(0, 500);
    if (!R || !text) return;
    inp.value = '';
    R.provider.sendChat(text).catch(err => { console.warn(err); toast('Message not sent.', 'err'); });
  }
  function onKey(e) {
    if (!S.room || !S.room.endOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeEndModal(); return; }
    if (e.key === 'Tab') {
      const f = [document.getElementById('lc-end-cancel'), document.getElementById('lc-end-confirm')];
      const idx = f.indexOf(document.activeElement);
      e.preventDefault(); f[(idx + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }

  function init() {
    const el = root(); if (!el) return;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKey);
    // Leaving the panel stops the lobby preview (the room keeps running, like any call app).
    const panel = document.getElementById('panel-live');
    if (panel && window.MutationObserver) {
      new MutationObserver(() => {
        if (!panel.classList.contains('active') && S.view === 'lobby') teardownLobby();
      }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    // Signed out → release camera/microphone.
    setInterval(() => {
      if (typeof currentUser !== 'undefined' && !currentUser && (S.room || S.lobby)) { teardownRoom(); teardownLobby(); S.lobby = null; S.view = 'home'; }
    }, 1500);
    window.addEventListener('pagehide', () => { teardownRoom(); teardownLobby(); });
  }

  // Leave any lobby/room and go back to the live-class home (used when "View as" starts or ends).
  function reset() { teardownRoom(); teardownLobby(); S.lobby = null; S.view = 'home'; }

  window.LiveClass = {
    open: openLiveClass, openFromDoc, openSession, onDocShown, reset,
    providers: { LiveProvider, DemoProvider, LiveKitProvider }, detectProviderKind,
    parsePlanSections, pickSampleKey, SAMPLES, LK_CDN, CONSENT_VERSION,
    get state() { return S; },
  };
  window.openLiveClass = openLiveClass;

  // ════════════════════════════════════════════════════════════════════════════════════════
  // SPANISH UI (merged into the app dictionary; the MutationObserver in index.html applies it)
  // ════════════════════════════════════════════════════════════════════════════════════════
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'Live class': 'Aula en vivo', '▶ Start live class': '▶ Iniciar clase en vivo', 'Demo': 'Demo',
    'Teach online from TeroClass: video, your class plan beside you, and learning insights after class.': 'Dá clase online desde TeroClass: video, tu planificación al lado y aprendizajes de cada estudiante después de la clase.',
    'Start a live class': 'Iniciar una clase en vivo', 'Class plan': 'Planificación', 'Sample plan (no saved class)': 'Plan de ejemplo (sin clase guardada)',
    'Tip: save a class first and it will appear here with its activity timers.': 'Consejo: guardá una clase y va a aparecer acá con los temporizadores de cada actividad.',
    'Upcoming sessions': 'Próximas sesiones', 'Past sessions': 'Sesiones anteriores', 'participants': 'participantes', 'Open lobby': 'Abrir sala de espera',
    'Insights ready': 'Insights listos', 'View insights': 'Ver insights', 'How it works': 'Cómo funciona', 'Lobby': 'Sala de espera', 'Class': 'Clase', 'Insights': 'Insights',
    'Check your camera and microphone. Each person gives separate consent for recording, AI analysis and storage.': 'Probá tu cámara y micrófono. Cada persona da consentimientos separados para grabación, análisis con IA y almacenamiento.',
    'Teach with your plan and activity timers beside the video. A red REC indicator is always visible and you can pause it.': 'Das la clase con tu planificación y los temporizadores al lado del video. El indicador rojo REC siempre está visible y lo podés pausar.',
    'After class: a recap, progress and feedback for each student, and an observation report for you.': 'Después de la clase: resumen, progreso y devolución para cada estudiante, y un informe de observación para vos.',
    'Only participants who consent are recorded. The others attend normally.': 'Solo se graba a quienes dan su consentimiento. El resto participa normalmente.',
    'Under 18: a parent or guardian must consent.': 'Menores de 18: tiene que consentir su madre, padre o tutor/a.',
    'Speakers are identified by their own microphone, never by voiceprint. No emotion detection.': 'Cada persona se identifica por su propio micrófono, nunca por huella de voz. Sin detección de emociones.',
    'Raw audio is deleted after 30 days.': 'El audio original se borra a los 30 días.',
    // lobby
    '← Back to live classes': '← Volver a Aula en vivo', '← Back to my classes': '← Volver a mis clases', 'Get ready to join': 'Preparate para entrar', 'Camera and microphone': 'Cámara y micrófono',
    'Camera': 'Cámara', 'Microphone': 'Micrófono', 'Camera is off': 'Cámara apagada', 'No camera': 'Sin cámara', 'Not available': 'No disponible',
    'Your camera preview': 'Vista previa de tu cámara', 'Turn microphone off': 'Apagar micrófono', 'Turn microphone on': 'Encender micrófono',
    'Turn camera off': 'Apagar cámara', 'Turn camera on': 'Encender cámara', 'Try again': 'Reintentar',
    'Camera and microphone access is blocked. You can still join without them, or allow access in your browser and try again.': 'El acceso a la cámara y al micrófono está bloqueado. Podés entrar igual sin ellos, o permitir el acceso en el navegador y reintentar.',
    'No camera or microphone was found. You can still join and use the chat.': 'No se encontró cámara ni micrófono. Podés entrar igual y usar el chat.',
    'Your camera or microphone is being used by another app.': 'Otra aplicación está usando tu cámara o micrófono.',
    'This browser cannot use the camera here (it needs a secure https connection).': 'Este navegador no puede usar la cámara acá (necesita una conexión segura https).',
    'Could not start the camera or microphone.': 'No se pudo iniciar la cámara o el micrófono.',
    'No camera available — you will join with audio only.': 'No hay cámara: vas a entrar solo con audio.',
    'No microphone available — you will join with video only.': 'No hay micrófono: vas a entrar solo con video.',
    'About you': 'Tus datos', 'Your name': 'Tu nombre', 'Joining as': 'Entrás como', 'Teacher': 'Docente', 'Student': 'Estudiante', 'Students': 'Estudiantes',
    'Recording and privacy': 'Grabación y privacidad',
    'This class can be recorded to create learning insights. Each consent is separate and optional — you can join without any of them.': 'Esta clase se puede grabar para generar insights de aprendizaje. Cada consentimiento es separado y opcional: podés entrar sin dar ninguno.',
    'Recording.': 'Grabación.', 'I agree that my voice is recorded during this class.': 'Acepto que se grabe mi voz durante esta clase.',
    'AI analysis.': 'Análisis con IA.', 'I agree that AI transcribes and analyses my participation to create learning insights.': 'Acepto que una IA transcriba y analice mi participación para generar insights de aprendizaje.',
    'Storage.': 'Almacenamiento.', 'I agree that the results are kept in my TeroClass record. Raw audio is deleted after 30 days.': 'Acepto que los resultados se guarden en mi registro de TeroClass. El audio original se borra a los 30 días.',
    "I'm under 18": 'Soy menor de 18 años', 'A parent or guardian must give consent for participants under 18.': 'Para menores de 18, el consentimiento lo tiene que dar su madre, padre o tutor/a.',
    "Guardian's full name": 'Nombre completo del tutor/a', "Guardian's email": 'Email del tutor/a',
    'I am the parent or guardian and I give the consents marked above.': 'Soy la madre, el padre o tutor/a y doy los consentimientos marcados arriba.',
    'Demo: kept only in this browser tab, never sent.': 'Demo: se guarda solo en esta pestaña, no se envía.',
    '● You will be recorded': '● Vas a ser grabado/a', 'AI analysis ✓': 'Análisis con IA ✓', 'No AI analysis': 'Sin análisis con IA',
    'Results stored ✓': 'Resultados guardados ✓', 'Results not stored': 'Resultados sin guardar', 'Waiting for guardian consent': 'Falta el consentimiento del tutor/a',
    'You will join without being recorded': 'Vas a entrar sin ser grabado/a', 'Join class': 'Entrar a la clase', 'Connecting…': 'Conectando…',
    'No emotion detection. Speakers are identified by their own microphone, never by voiceprint. You can stop being recorded at any time.': 'Sin detección de emociones. Cada persona se identifica por su propio micrófono, nunca por huella de voz. Podés dejar de ser grabado/a en cualquier momento.',
    'Please write your name.': 'Escribí tu nombre.', "Please write the guardian's name.": 'Escribí el nombre del tutor/a.',
    'Please write a valid guardian email.': 'Escribí un email válido del tutor/a.', 'The guardian must confirm the consent.': 'El tutor/a tiene que confirmar el consentimiento.',
    'Could not join the class.': 'No se pudo entrar a la clase.',
    // room
    'Simulated participants': 'Participantes simulados', 'LiveKit': 'LiveKit', 'Not recording': 'Sin grabar', 'REC': 'REC', 'REC paused': 'REC en pausa',
    'Document': 'Documento', 'Talk time': 'Tiempo de habla', 'Class time': 'Tiempo de clase', 'Side panel': 'Panel lateral', 'Chat': 'Chat', 'People': 'Personas', 'Close panel': 'Cerrar panel',
    'Message': 'Mensaje', 'PH:Write a message…': 'Escribí un mensaje…', 'Send': 'Enviar', 'Class controls': 'Controles de la clase',
    'Mute': 'Silenciar', 'Unmute': 'Activar micrófono', 'Stop video': 'Apagar video', 'Start video': 'Encender video', 'Share screen': 'Compartir pantalla', 'Stop sharing': 'Dejar de compartir',
    'Raise hand': 'Levantar la mano', 'Lower hand': 'Bajar la mano', 'Plan': 'Plan', 'Record': 'Grabar', 'Stop recording': 'Detener grabación', 'Pause': 'Pausar', 'Resume': 'Reanudar',
    'End class': 'Terminar clase', 'Leave': 'Salir', 'End the class for everyone?': '¿Terminar la clase para todos?',
    'The call ends for all participants. If you recorded, insights are prepared next.': 'La llamada termina para todos. Si grabaste, a continuación se preparan los insights.',
    'Cancel': 'Cancelar', 'Consented to recording': 'Consintió la grabación', 'Guardian consent': 'Consentimiento del tutor/a', 'Guardian ✓': 'Tutor/a ✓',
    'Attends without recording': 'Participa sin ser grabado/a', 'Recorded': 'Grabado', 'Not recorded': 'No se graba', '(you)': '(vos)', 'You are presenting': 'Estás presentando',
    'recorded': 'grabados', 'Microphone on': 'Micrófono encendido', 'Microphone off': 'Micrófono apagado', 'Camera on': 'Cámara encendida', 'Camera off': 'Cámara apagada', 'Hand raised': 'Mano levantada',
    'No messages yet. Messages are visible to everyone in the class.': 'Todavía no hay mensajes. Los mensajes los ve toda la clase.',
    'Planned': 'Planificado', 'Activities': 'Actividades', 'Sample plan — open a saved class to see yours here.': 'Plan de ejemplo: abrí una clase guardada para ver la tuya acá.',
    'Objectives and notes': 'Objetivos y notas', 'Whole class': 'Clase completa', 'Reset timer': 'Reiniciar temporizador', 'Details': 'Detalles',
    '▶ Start': '▶ Iniciar', '⏸ Pause': '⏸ Pausar', '▶ Resume': '▶ Reanudar', 'Next activity ⏭': 'Siguiente actividad ⏭',
    'raised a hand': 'levantó la mano', 'Recording started': 'Grabación iniciada', 'participants consented': 'participantes dieron su consentimiento',
    'Recording stopped': 'Grabación detenida', 'Recording paused': 'Grabación en pausa', 'Recording resumed': 'Grabación reanudada',
    'The teacher started recording. You are being recorded.': 'El/la docente empezó a grabar. Te están grabando.',
    'The teacher started recording. You are not being recorded.': 'El/la docente empezó a grabar. A vos no te graban.',
    'You joined without being recorded.': 'Entraste sin ser grabado/a.', 'You were disconnected.': 'Se perdió la conexión.',
    'Screen sharing is not available in this browser.': 'Este navegador no permite compartir pantalla.', 'Screen sharing was cancelled.': 'Se canceló compartir pantalla.',
    'You are sharing your screen (demo: only you can see it).': 'Estás compartiendo tu pantalla (demo: solo la ves vos).',
    'You are sharing your screen with the class.': 'Estás compartiendo tu pantalla con la clase.', 'is presenting': 'está presentando', 'is sharing their screen': 'está compartiendo su pantalla',
    'Could not connect to the live classroom — opening the demo instead.': 'No se pudo conectar al aula en vivo: se abre la demo.',
    'A live class is already in progress.': 'Ya hay una clase en vivo en curso.', 'Message not sent.': 'No se envió el mensaje.',
    // processing
    'Preparing your class insights': 'Preparando los insights de tu clase', 'Saving audio': 'Guardando el audio', 'Transcribing': 'Transcribiendo', 'Analyzing': 'Analizando',
    'Only the voices of participants who consented': 'Solo las voces de quienes dieron su consentimiento', 'Speech to text, one track per microphone': 'De voz a texto, una pista por micrófono',
    'Student progress and teacher observation': 'Progreso de cada estudiante y observación docente',
    'Nothing was recorded in this demo — the insights below use sample data.': 'En esta demo no se grabó nada: los insights usan datos de ejemplo.',
    "In the real classroom this takes a few minutes after class; you'll be notified when the insights are ready.": 'En el aula real esto lleva unos minutos después de la clase; te avisamos cuando los insights estén listos.',
    'Skip': 'Saltar',
    // insights (labels of the shared view are in public/insights-view.js)
    'Class insights': 'Insights de la clase', 'Sample': 'Ejemplo', 'Sample:': 'Ejemplo:', 'Language class (EN)': 'Clase de idioma (EN)', 'Chemistry (ES)': 'Química (ES)',
    'Draft ready — edit it before sending.': 'Borrador listo: editalo antes de enviarlo.', 'Write a message first.': 'Primero escribí un mensaje.',
    'Demo: the message was not sent. In the real classroom the student sees it with their insights.': 'Demo: el mensaje no se envió. En el aula real el estudiante lo ve junto con sus insights.',
    'Reflection saved in this browser tab (demo).': 'Reflexión guardada en esta pestaña (demo).',
    'Demo insights saved for this class.': 'Se guardaron insights de demo para esta clase.', 'Open in Insights': 'Abrir en Insights',
  });

  init();
  // The app may already have translated the page before this file loaded.
  try { if (typeof uiLang !== 'undefined' && uiLang === 'es' && typeof translateTree === 'function') { i18nBusy = true; try { translateTree(document.body); } finally { i18nBusy = false; } } } catch (e) { /* ignore */ }
})();
