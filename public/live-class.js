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
 *
 * RECORDING CONSENT (2026-10): ONE checkbox, asked the first time a person enters any class room (teachers too), stored
 * per person in the database (001_base.sql: user_consents, my_consent / grant_recording_consent / revoke_recording_consent).
 * A "yes" is permanent until revoked from the profile menu ("Recording of my classes") or until CONSENT_VERSION changes.
 * A "no" offers an OPTIONAL comment ("¿Querés contarnos por qué? (opcional)", decline_recording_consent → the institution's
 * admins only if something was written; emailed by /api/notify/consent when RESEND_API_KEY exists) and the person joins NOT
 * recorded; asked again next class.
 * Under 18 (P-10): guardian name + email + the student's DECLARATION that the guardian agrees (not verified; shown as
 * "declared by the student"), unless the institution manages the families' consent itself (consent_managed). Classes are recorded AUTOMATICALLY (audio only, only
 * people who consented); the teacher can pause ("Pause recording"), and it resumes by itself after PAUSE_MAX_S.
 * The LiveKit token (api/_lib/class/token.js) reads the consent from the database, never from this browser.
 */
(function () {
  'use strict';

  const LK_VERSION = '2.22.3';
  // served from this site (TC-11: no third-party script; public/vendor/licenses)
  const LK_CDN = `/vendor/livekit-client-${LK_VERSION}.umd.js`;
  const CONSENT_VERSION = '2026-10'; // = tc_consent_version() (001_base.sql) and api/_lib/class/token.js; bump all three when the text changes
  const CONSENT_TEXT = 'I agree that my classes on TeroClass are recorded (audio only) and that AI analyses them to create my insights and improve the classes.';
  const CONSENT_MORE = ['Only your voice is recorded (audio), never video, and only for people who agreed.',
    'AI creates your learning insights (recap, progress and feedback) and the teacher\'s observation report, to improve the classes.',
    'The original audio is deleted after 30 days; the insights stay in your TeroClass record.',
    'Each person is identified by their own microphone, never by voiceprint. No emotion detection.',
    'You can turn it off at any time from your profile menu (Recording of my classes).',
    'Under 18: a parent or guardian must agree. You declare it here; TeroClass does not verify it.'];
  // P-11 (2026-10): saying no needs NO justification; an optional comment reaches the institution only if written
  const PAUSE_MAX_S = 5 * 60;      // a teacher's pause resumes by itself after 5 minutes
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
  //   connect({room,name,role,recorded,minor,guardianOk,localStream}) → Promise (recording starts 'on': auto-recording)
  //   disconnect(), setMicrophoneEnabled(on), setCameraEnabled(on),
  //   startScreenShare(stream), stopScreenShare(), sendChat(text), setHandRaised(up),
  //   setRecording('on'|'paused'|'off') (teacher: pause / resume; 'off' only at the end), attachVideo(participantId, videoEl), participants(),
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
    async publishMic() {}
    async startAudio() {}
    async startScreenShare() {}
    async stopScreenShare() {}
    async sendChat() {}
    async setHandRaised() {}
    async setRecording() {}
    attachVideo() { return false; }
    attachScreen() { return false; }
  }

  // ── Demo: simulated classmates, nothing leaves the browser ──
  // one consent covers recording + AI analysis + storage (see CONSENT_TEXT)
  const DEMO_PEOPLE = [
    { name: 'Valentina Ruiz', yes: true },
    { name: 'Mateo Fernández', yes: true },
    { name: 'Sofía Pereira', yes: true },
    { name: 'Lucas Silva', yes: false, cam: false },
    { name: 'Martina Gómez', minor: true, guardianOk: true, yes: true },
    { name: 'Joaquín Castro', minor: true, guardianOk: false, yes: false, mic: false },
  ];
  const allConsent = yes => ({ recording: !!yes, ai_analysis: !!yes, storage: !!yes });
  class DemoProvider extends LiveProvider {
    get kind() { return 'demo'; }
    async connect(o) {
      this.o = o;
      const local = { id: 'local', isLocal: true, name: o.name, role: o.role, mic: !!o.mic, cam: !!o.cam, consent: allConsent(o.recorded), recorded: !!o.recorded, minor: !!o.minor, guardianOk: !!o.guardianOk, hand: false };
      // P-07 (2026-10): real people never see invented classmates or teachers. Sample participants only when someone
      // asks for them ("Show sample participants (demo)" on the live-class home, or the owner's View as).
      if (!o.simulate) {
        this._list = [local]; this._timers = []; this._speaker = null; this._hold = 0;
        await new Promise(r => setTimeout(r, 150));
        this.emit('participants', this._list);
        return;
      }
      const others = DEMO_PEOPLE.map((p, i) => ({
        id: 'sim-' + i, name: p.name, role: 'student', mic: p.mic !== false, cam: p.cam !== false, consent: allConsent(p.yes),
        recorded: !!p.yes && (!p.minor || !!p.guardianOk), minor: !!p.minor, guardianOk: !!p.guardianOk, hand: false,
      }));
      if (o.role !== 'teacher') { others.splice(5); others.unshift({ id: 'sim-t', name: o.teacherName || tr('Teacher (sample)'), role: 'teacher', mic: true, cam: true, consent: allConsent(true), recorded: true, minor: false, guardianOk: false, hand: false }); }
      this._list = [local, ...others];
      this._speaker = null; this._hold = 0; this._t0 = Date.now();
      this._timers = [setInterval(() => this._tick(), 900)];
      this._later(7000, () => this.emit('chat', { from: 'sim-1', name: 'Mateo Fernández', text: o.role === 'teacher' ? 'Can you repeat the last example, please?' : 'Hi everyone!', ts: Date.now() }));
      this._later(11000, () => this._setHand('sim-2', true));
      this._later(26000, () => this._setHand('sim-2', false));
      if (o.role !== 'teacher') this._later(4000, () => this._startSimShare(o));
      await new Promise(r => setTimeout(r, 250)); // feels like a connection
      this.emit('participants', this._list);
    }
    _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }
    // Demo (sample participants on): the teacher shares a slide (a canvas stream), so students see a shared screen
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
      this._screens = [{ id: 'sim-t', name: o.teacherName || tr('Teacher (sample)') }];
      this.emit('screens', this._screens);
    }
    attachScreen(id, el) { if (id === 'sim-t' && this._screenStream) { if (el.srcObject !== this._screenStream) el.srcObject = this._screenStream; return true; } return false; }
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
        // consent is NOT sent: the server reads it from the database (my_consent) with this session
        // the role is decided by the server (P-09); a ticket = the invitation link of an ad-hoc room (TC-13)
        body: JSON.stringify({ room: o.room, role: o.role, ...(o.ticket ? { ticket: o.ticket } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.token) throw new Error(j.error || 'Could not join the class.');
      const room = new LK.Room({ adaptiveStream: true, dynacast: true });
      this.room = room;
      const E = LK.RoomEvent;
      const sync = () => this._sync();
      this._rec = 'on'; // auto-recording: on from the start for everyone who consented
      room
        .on(E.ParticipantConnected, () => {
          sync(); this._ensureRec();
          // someone joined while the teacher had paused: tell them (the default for a newcomer is "on")
          if (o.role === 'teacher' && this._rec !== 'on') this._send({ type: 'rec', state: this._rec }).catch(() => {});
        })
        .on(E.ParticipantDisconnected, sync)
        .on(E.TrackSubscribed, (track) => {
          // remote voices must be attached to an <audio> element to be heard
          if (track.kind === 'audio') {
            const el = track.attach(); el.className = 'lc-remote-audio'; el.hidden = true; document.body.appendChild(el);
            // 2026-10-29: browsers (Safari above all) can block sound that starts without a click → ask for one click
            try { const pr = el.play && el.play(); if (pr && pr.catch) pr.catch(() => this.emit('audioblocked', true)); } catch (e) { /* ignore */ }
          }
          sync();
        })
        .on(E.TrackUnsubscribed, (track) => { try { track.detach().forEach(el => { el.srcObject = null; if (el.classList.contains('lc-remote-audio')) el.remove(); }); } catch (e) { /* ignore */ } sync(); })
        .on(E.TrackMuted, sync)
        .on(E.TrackUnmuted, sync)
        .on(E.ParticipantMetadataChanged, sync)
        .on(E.ActiveSpeakersChanged, (speakers) => this.emit('speaking', new Set(speakers.map(s => this._id(s)))))
        .on(E.DataReceived, (payload, participant) => this._onData(payload, participant))
        .on(E.TrackPublished, () => this._ensureRec())
        .on(E.AudioPlaybackStatusChanged, () => this.emit('audioblocked', !room.canPlaybackAudio))
        .on(E.Disconnected, () => this.emit('disconnected'));
      await room.connect(j.url, j.token);
      if (!room.canPlaybackAudio) this.emit('audioblocked', true);
      const lp = room.localParticipant;
      const [a] = o.localStream ? o.localStream.getAudioTracks() : [];
      const [v] = o.localStream ? o.localStream.getVideoTracks() : [];
      if (a) await lp.publishTrack(a, { source: LK.Track.Source.Microphone });
      if (v) await lp.publishTrack(v, { source: LK.Track.Source.Camera, simulcast: true });
      if (a && !o.mic) await lp.setMicrophoneEnabled(false);
      if (v && !o.cam) await lp.setCameraEnabled(false);
      this._sync();
      this._ensureRec();
    }
    // 2026-10-29: automatic recording must not depend only on the LiveKit webhook: the teacher's browser asks the server to
    // (re)start every consented microphone when the class starts and whenever someone joins or turns a mic on. The server
    // re-checks consent in the database and never records the same microphone twice.
    _ensureRec() {
      if (this.o?.role !== 'teacher' || this._rec !== 'on') return;
      clearTimeout(this._ensureT);
      this._ensureT = setTimeout(() => { if (this.room && this._rec === 'on') this._postRec('on'); }, 2500);
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
          mic: !!mic && !mic.isMuted, cam: !!cam && !cam.isMuted, consent: m.consent || {}, recorded: !!m.recorded, recActive: !!m.rec_active,
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
      if (pub && pub.track) { if (!(pub.track.attachedElements || []).includes(el)) pub.track.attach(el); return true; }
      return false;
    }
    attachVideo(id, el) {
      if (!this.room || id === 'local') return false;
      const p = this.room.remoteParticipants.get(id);
      const pub = p && p.getTrackPublication(this.LK.Track.Source.Camera);
      if (pub && pub.track) { if (!(pub.track.attachedElements || []).includes(el)) pub.track.attach(el); return true; }
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
    // a microphone allowed after joining (it was blocked or missing in the lobby)
    async publishMic(track) { await this.room.localParticipant.publishTrack(track, { source: this.LK.Track.Source.Microphone }); this._sync(); this._ensureRec(); }
    async startAudio() {
      try { await this.room.startAudio(); } catch (e) { /* ignore */ }
      document.querySelectorAll('audio.lc-remote-audio').forEach(el => { try { const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) { /* ignore */ } });
      this.emit('audioblocked', !this.room.canPlaybackAudio);
    }
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
      // Auto-recording: the server (LiveKit webhook → api/_lib/rec/pipeline.js) records from the start every microphone whose
      // owner has a valid consent IN THE DATABASE; the {type:"rec"} messages update everyone's indicator ('off' = class ended)
      // and POST /api/class/rec makes the server really stop / restart the recordings (teacher / substitute only).
      this._rec = state;
      await this._send({ type: 'rec', state });
      this.emit('recording', state);
      if (state === 'on' || state === 'paused') this._postRec(state);
    }
    // Recording pipeline on (APP_CONFIG.recording) and a calendar class: tell the server. Never blocks the room.
    async _postRec(state) {
      if (!recorderOn() || this.o?.role !== 'teacher' || !/^sess-[0-9a-f]{32}$/.test(String(this.o?.room || ''))) return null;
      try {
        const { data: { session } = {} } = await sb.auth.getSession();
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
        const r = await fetch('/api/class/rec', { method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session?.access_token || '') },
          body: JSON.stringify({ room: this.o.room, state }) }).finally(() => clearTimeout(t));
        return r.ok ? await r.json().catch(() => ({})) : null;
      } catch (e) { console.warn('recording state not sent', e); return null; }
    }
    // The teacher ends a recorded calendar class: the server stops the recordings, closes the room for everyone and starts
    // processing (transcription → insights)
    async endForAll() { return this._postRec('end'); }
    async disconnect() { clearTimeout(this._ensureT); try { await this.room?.disconnect(); } catch (e) { /* ignore */ } document.querySelectorAll('audio.lc-remote-audio').forEach(el => el.remove()); this.room = null; this._h = {}; }
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
    demo: false,           // P-07: only the explicit "Try the demo" path shows invented people / sample plans / sample insights
    adhocRoom: null, ticket: null, // TC-13: an ad-hoc room joined with the creator's invitation link (?room=…&t=…)
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

  function render() {
    const el = root(); if (!el) return;
    el.dataset.view = S.view;
    if (S.view === 'home') el.innerHTML = homeHtml();
    else if (S.view === 'lobby') { el.innerHTML = lobbyHtml(); afterLobbyRender(); }
    else if (S.view === 'room') { el.innerHTML = roomHtml(); afterRoomRender(); }
    else if (S.view === 'processing') el.innerHTML = processingHtml();
    else if (S.view === 'insights') el.innerHTML = insightsHtml();
    syncRoomBg();
    const h = el.querySelector('h1'); if (h && S.view !== 'room') { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    el.scrollTop = 0;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // HOME (sessions list)
  // ════════════════════════════════════════════════════════════════════════════════════════
  // P-07 (2026-10): the home lists the person's REAL next classes (calendar); invented sessions are gone
  const HOME = { rows: null, loading: false, seq: 0 };
  async function loadHomeSessions() {
    if (HOME.loading || typeof sb === 'undefined' || !currentUser) return;
    HOME.loading = true; const seq = ++HOME.seq;
    try {
      const from = new Date(Date.now() - 2 * 3600e3); const to = new Date(Date.now() + 14 * 864e5);
      const { data, error } = await sb.rpc('my_calendar', { p_from: from.toISOString(), p_to: to.toISOString() });
      if (seq !== HOME.seq) return;
      HOME.rows = error ? [] : (Array.isArray(data) ? data : []).filter(r => r.status !== 'cancelled' && Date.parse(r.ends_at) > Date.now()).slice(0, 6);
    } catch (e) { HOME.rows = []; } finally { HOME.loading = false; }
    if (S.view === 'home' && document.getElementById('lc-up-list')) document.getElementById('lc-up-list').innerHTML = upcomingHtml();
  }
  function upcomingHtml() {
    if (HOME.rows === null) return '<li class="lc-hint">Loading…</li>';
    if (!HOME.rows.length) return '<li class="lc-hint">No classes in the next two weeks. Schedule them in the Calendar.</li>';
    const fmt = d => { try { return new Date(d).toLocaleString(typeof uiLocale === 'function' ? uiLocale() : undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return d; } };
    return HOME.rows.map(r => `<li class="lc-session">
      <div class="lc-session-main"><div class="lc-session-title" data-no-i18n>${esc(r.title || r.group_name || '')}</div>
      <div class="lc-session-meta"><span data-no-i18n>${esc(fmt(r.starts_at))}</span>${r.group_name ? ` · <span data-no-i18n>${esc(r.group_name)}</span>` : ''}${r.planning_title ? ` · <span class="lc-chip">📖 <span data-no-i18n>${esc(r.planning_title)}</span></span>` : ''}</div></div>
      <button type="button" class="lc-btn" data-lc="open-cal" data-id="${esc(r.id)}">Open in Calendar</button></li>`).join('');
  }
  function homeHtml() {
    const list = (typeof plannings !== 'undefined' && Array.isArray(plannings)) ? plannings : [];
    if (HOME.rows === null) setTimeout(loadHomeSessions, 0);
    const opts = list.map(p => `<option value="${esc(p.id)}" data-no-i18n>${esc(p.title || 'Class')}</option>`).join('');
    const live = typeof APP_CONFIG !== 'undefined' && APP_CONFIG.live === true;
    return `<div class="lc-wrap">
      <header class="lc-head">
        <div><h1><span aria-hidden="true">🎥</span> <span>Live class</span></h1>
        <p class="lc-sub">Teach online from TeroClass: video, your class plan beside you, and learning insights after class.</p></div>
      </header>
      ${live ? '' : '<p class="lc-note" id="lc-not-connected" role="note"><span aria-hidden="true" data-no-i18n>ℹ️</span> <span>The video classroom is not connected yet: a room opens in preview mode (only you, nothing is recorded).</span></p>'}
      <section class="lc-card lc-start" aria-labelledby="lc-start-h">
        <h2 id="lc-start-h">Start a live class</h2>
        <p class="lc-hint">Your scheduled classes are in the Calendar. Here you can open a quick room and invite your students with a link.</p>
        <div class="lc-start-row">
          <div class="lc-field"><label for="lc-plan-select">Class plan</label>
            <select id="lc-plan-select"><option value="">No plan</option>${opts}</select></div>
          <button type="button" class="lc-btn lc-primary" data-lc="start" id="lc-start-btn">▶ Start live class</button>
        </div>
        ${list.length ? '' : '<p class="lc-hint">Tip: save a class first and it will appear here with its activity timers.</p>'}
        <p class="lc-hint lc-nb-hint" id="lc-nb-hint">📒 <span>For a notebook and a board, enter from a class in the Calendar.</span></p>
      </section>
      <section class="lc-card lc-demo-card" id="lc-demo-card" aria-labelledby="lc-demo-h">
        <h2 id="lc-demo-h"><span aria-hidden="true">🧪</span> <span>Try the demo</span></h2>
        <p class="lc-hint">See how a class looks with a sample plan, invented participants and sample insights. Nothing is saved and nobody else sees it.</p>
        <button type="button" class="lc-btn" data-lc="try-demo" id="lc-try-demo">▶ Try the demo</button>
      </section>
      <div class="lc-two">
        <section class="lc-card" aria-labelledby="lc-up-h">
          <h2 id="lc-up-h">Your next classes</h2>
          <ul class="lc-sessions" id="lc-up-list">${upcomingHtml()}</ul>
        </section>
        <section class="lc-card" aria-labelledby="lc-past-h">
          <h2 id="lc-past-h">Past classes</h2>
          <p class="lc-hint">The insights of the classes you taught are in Insights.</p>
          <button type="button" class="lc-btn" data-lc="open-insights">💡 <span>Open Insights</span></button>
        </section>
      </div>
      <section class="lc-card lc-how" aria-labelledby="lc-how-h">
        <h2 id="lc-how-h">How it works</h2>
        <ol class="lc-steps">
          <li><b>Lobby</b><span>Check your camera and microphone. The first time, each person is asked once for consent to record their classes (audio only).</span></li>
          <li><b>Class</b><span>Classes are recorded automatically, only for people who consented. The indicator is always visible and the teacher can pause it.</span></li>
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
      // P-09: the role comes from the class (calendar row) or the room: whoever opens an invitation link joins as a student
      name: (currentUser && currentUser.name) || '', role: S.sessionRole || (S.adhocRoom ? 'student' : isStaff ? 'teacher' : 'student'),
      camId: '', micId: '', stream: null, mediaError: '', mic: true, cam: true, level: 0,
      devices: { cams: [], mics: [] },
      // recording consent: 'loading' → 'ask' (one checkbox) or 'granted' (asked before, nothing to do)
      cstate: 'loading', agree: false, recorded: false, minor: false, guardian: { name: '', email: '', consent: false }, error: '',
      declineOpen: false,
    };
  }
  // P-10: the guardian's agreement is declared by the student (not verified), or managed by the institution
  const managedConsent = () => !!(CS.data && CS.data.consent_managed);
  const guardianOk = G => managedConsent() || !!(G.guardian.name.trim() && EMAIL_RE.test(G.guardian.email.trim()) && G.guardian.consent);
  const willBeRecorded = L => L.cstate === 'granted' ? L.recorded : (L.cstate === 'ask' && L.agree && (!L.minor || guardianOk(L)) && !inViewAs());
  const inViewAs = () => typeof viewAs !== 'undefined' && !!viewAs;

  function consentSummaryHtml(L) {
    if (L.cstate === 'loading') return '';
    if (willBeRecorded(L)) return '<span class="lc-chip lc-chip-rec">● You will be recorded (audio only)</span>';
    if (L.cstate === 'ask' && L.agree && L.minor) return '<span class="lc-chip lc-chip-warn">Waiting for guardian consent</span>';
    return '<span class="lc-chip lc-chip-off">You will join without being recorded</span>';
  }

  // ── recording consent (database: my_consent / grant / revoke / decline) ──────────────────────────────────
  const CS = { data: null, uid: null, loading: null };
  const rpcJson = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw error;
    let d = data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* keep */ } }
    return d;
  };
  const consentOk = d => !!(d && d.granted === true && d.current_version === CONSENT_VERSION);
  // the person's current consent; null when it can't be read (then we ask; not recorded unless they say yes)
  async function loadConsent(force) {
    if (inViewAs() || typeof sb === 'undefined' || !currentUser) return null;
    const me = currentUser.id;
    if (!force && CS.data && CS.uid === me) return CS.data;
    if (!force && CS.loading) return CS.loading;
    const p = (async () => {
      try { const d = await rpcJson('my_consent'); if (currentUser?.id === me) { CS.data = d; CS.uid = me; } return d; }
      catch (e) { console.warn('consent: could not read', e?.message || e); return null; }
      finally { if (CS.loading === p) CS.loading = null; }
    })();
    CS.loading = p;
    return p;
  }
  async function grantConsent(G) {
    // P-10: the student DECLARES that their guardian agrees (stored as guardian_source 'student'); with an institution that
    // manages the families' consent itself, the database ignores the guardian fields (guardian_source 'institution')
    const d = await rpcJson('grant_recording_consent', { p_version: CONSENT_VERSION, p_minor: !!G.minor,
      p_guardian_name: G.minor && !managedConsent() ? G.guardian.name.trim() : null, p_guardian_email: G.minor && !managedConsent() ? G.guardian.email.trim() : null,
      p_guardian_consent: !!(G.minor && (managedConsent() || G.guardian.consent)) });
    CS.data = d; CS.uid = currentUser?.id; return d;
  }
  async function revokeConsent() { const d = await rpcJson('revoke_recording_consent'); CS.data = d; CS.uid = currentUser?.id; return d; }
  async function declineConsent(sessionId, reason) {
    const d = await rpcJson('decline_recording_consent', { p_session: sessionId || null, p_reason: reason });
    CS.data = null; // a "no" is not stored as an answer: read it again next time
    // email the admins (no-op on the server without RESEND_API_KEY); never blocks joining
    try {
      const { data: { session } = {} } = await sb.auth.getSession();
      fetch('/api/notify/consent', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session?.access_token || '') },
        body: JSON.stringify({ lang: typeof uiLang !== 'undefined' && uiLang === 'en' ? 'en' : 'es' }) }).catch(() => {});
    } catch (e) { /* ignore */ }
    return d;
  }
  const dbMsg = e => { const m = String(e?.message || e || ''); return typeof dbErr === 'function' ? dbErr(m) : m; };

  // one checkbox (+ under 18 → guardian), shared by the lobby and the profile dialog. P = id prefix.
  function consentFieldsHtml(G, P, { ro = false } = {}) {
    return `<label class="lc-check lc-consent-main"><input type="checkbox" id="${P}consent" ${G.agree ? 'checked' : ''} ${ro ? 'disabled' : ''}> <span>${esc(CONSENT_TEXT)}</span></label>
      <details class="lc-more"><summary>More information</summary><ul>${CONSENT_MORE.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>
      <label class="lc-check lc-minor"><input type="checkbox" id="${P}minor" ${G.minor ? 'checked' : ''} ${ro ? 'disabled' : ''}> <span><b>I'm under 18</b></span></label>
      <div class="lc-guardian" id="${P}guardian" ${G.minor ? '' : 'hidden'}>${managedConsent()
        ? '<p class="lc-guardian-note" id="' + P + 'g-managed"><span aria-hidden="true">🏫</span> <span>Your institution already collected your family\'s authorization: you don\'t need to add your guardian\'s details.</span></p>'
        : `<p class="lc-guardian-note"><span aria-hidden="true">👪</span> <span>A parent or guardian must agree for participants under 18. You declare it here: TeroClass does not verify it, and your institution sees it as "declared by the student".</span></p>
        <div class="lc-field"><label for="${P}g-name">Guardian's full name</label><input id="${P}g-name" type="text" maxlength="120" autocomplete="off" value="${esc(G.guardian.name)}" ${ro ? 'disabled' : ''}></div>
        <div class="lc-field"><label for="${P}g-email">Guardian's email</label><input id="${P}g-email" type="email" maxlength="254" autocomplete="off" value="${esc(G.guardian.email)}" ${ro ? 'disabled' : ''}></div>
        <label class="lc-check"><input type="checkbox" id="${P}g-consent" ${G.guardian.consent ? 'checked' : ''} ${ro ? 'disabled' : ''}> <span>My parent or guardian agrees (I declare it).</span></label>`}
      </div>`;
  }
  function consentBlockHtml(L) {
    if (L.cstate === 'loading') return '<p class="lc-hint" id="lc-consent-loading">Checking your recording consent…</p>';
    if (L.cstate === 'granted') return `<div class="lc-consent-ok" id="lc-consent-ok"><span aria-hidden="true">✓</span> <span>You already agreed: your classes are recorded (audio only). We won't ask you again.</span></div>
      <p class="lc-fine">You can turn it off at any time from your profile menu (Recording of my classes).</p>`;
    const ro = inViewAs();
    return `<p class="lc-hint">We ask only once. If you don't agree, you can still join the class without being recorded.</p>
      <div class="lc-consents" role="group" aria-labelledby="lc-consent-h">${consentFieldsHtml(L, 'lc-', { ro })}</div>
      ${ro ? '<p class="lc-fine">View as is read-only: nothing is saved and you join without being recorded.</p>' : ''}`;
  }
  // the lobby asks the database whether this person already agreed (current text version)
  async function initLobbyConsent(L) {
    if (inViewAs()) { L.cstate = 'ask'; renderConsentBlock(); return; }
    const d = await loadConsent(true);
    if (S.lobby !== L) return;
    if (consentOk(d)) { L.cstate = 'granted'; L.recorded = !!d.recorded; L.minor = !!d.minor; L.guardianOkDb = !!d.guardian_consent; }
    else L.cstate = 'ask';
    renderConsentBlock();
  }
  function renderConsentBlock() {
    const L = S.lobby; const box = document.getElementById('lc-consent-box'); if (!L || !box) return;
    box.innerHTML = consentBlockHtml(L);
    syncConsentUi();
  }
  function declineModalHtml() {
    // a native modal <dialog> (top layer: above the app's top bar, focus kept inside, the rest inert)
    return `<dialog class="lc-dialog" id="lc-decline-modal" aria-labelledby="lc-decline-h" aria-describedby="lc-decline-p">
      <div class="lc-modal">
        <h2 id="lc-decline-h">No problem</h2>
        <p class="lc-decline-ok"><span aria-hidden="true">✓</span> <span>You can still join the class without being recorded.</span></p>
        <p id="lc-decline-p">If you write something, it goes to your institution. If you leave it empty, we only record that you said no.</p>
        <div class="lc-field"><label for="lc-decline-text">Do you want to tell us why? (optional)</label>
          <textarea id="lc-decline-text" rows="3" maxlength="1000" aria-describedby="lc-decline-min"></textarea>
          <span class="lc-fine" id="lc-decline-min">You can leave it empty.</span></div>
        <div class="lc-error" id="lc-decline-err" role="alert"></div>
        <div class="lc-modal-actions">
          <button type="button" class="lc-btn" data-lc="decline-back" id="lc-decline-back">← Back</button>
          <button type="button" class="lc-btn lc-primary" data-lc="decline-send" id="lc-decline-send">Join without recording</button>
        </div>
      </div>
    </dialog>`;
  }
  function openDecline() {
    const L = S.lobby; const m = document.getElementById('lc-decline-modal'); if (!L || !m) return;
    L.declineOpen = true; L.lastFocus = document.activeElement;
    const ta = document.getElementById('lc-decline-text'); if (ta) ta.value = ''; // prefill nothing
    const err = document.getElementById('lc-decline-err'); if (err) err.textContent = '';
    syncDeclineUi();
    if (!m.open) { try { m.showModal(); } catch (e) { m.setAttribute('open', ''); } }
    m.oncancel = ev => { ev.preventDefault(); closeDecline(true); }; // Esc
    setTimeout(() => document.getElementById('lc-decline-text')?.focus(), 20);
  }
  function closeDecline(focusCheckbox) {
    const L = S.lobby; const m = document.getElementById('lc-decline-modal'); if (m && m.open) { try { m.close(); } catch (e) { m.removeAttribute('open'); } }
    if (!L) return; L.declineOpen = false;
    try { (focusCheckbox ? document.getElementById('lc-consent') : L.lastFocus)?.focus(); } catch (e) { /* ignore */ }
  }
  function syncDeclineUi() {
    const b = document.getElementById('lc-decline-send'); if (b) b.disabled = false; // the comment is optional (P-11)
  }
  async function sendDecline(btn) {
    const L = S.lobby; const ta = document.getElementById('lc-decline-text'); if (!L || !ta) return;
    const text = ta.value.trim();
    const err = document.getElementById('lc-decline-err');
    if (btn) { btn.disabled = true; btn.textContent = tr('Joining…'); }
    try { await declineConsent(S.sessionId, text); }
    catch (e) {
      const m = String(e?.message || '');
      if (/Ya diste/.test(m)) { if (err) err.textContent = dbMsg(e); if (btn) { btn.disabled = false; btn.textContent = tr('Join without recording'); } return; }
      console.warn('consent decline not saved', e); toast('Your answer could not be saved. You join without being recorded.', 'err');
    }
    if (S.lobby !== L) return;
    L.recorded = false; L.agree = false;
    closeDecline();
    const j = document.getElementById('lc-join'); if (j) { j.disabled = true; j.textContent = tr('Connecting…'); }
    stopMeter();
    try { await enterRoom(); } catch (e2) { console.warn(e2); setLobbyError('Could not join the class.'); if (j) { j.disabled = false; j.textContent = tr('Join class'); } }
  }

  function lobbyHtml() {
    const L = S.lobby;
    return `<div class="lc-wrap lc-lobby">
      ${S.demo ? banner() : ''}
      <button type="button" class="lc-link" data-lc="back-home">${studentBack() ? '← Back to my classes' : '← Back to live classes'}</button>
      <header class="lc-head"><div><h1>Get ready to join</h1><p class="lc-sub" data-no-i18n>${esc(S.sessionTitle)}</p></div>${S.demo ? demoChip() : ''}</header>
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
          <!-- P-09 / TC-27: the role and the name come from your account and this class (decided by the server), never chosen here -->
          <p class="lc-joinas" id="lc-joinas"><span>You join as</span> <b data-no-i18n id="lc-name-show">${esc(L.name || '')}</b> · <span class="lc-chip">${L.role === 'teacher' ? 'Teacher' : 'Student'}</span></p>
          <h2 id="lc-consent-h">Recording and privacy</h2>
          <div class="lc-consent-box" id="lc-consent-box">${consentBlockHtml(L)}</div>
          <div class="lc-consent-summary" id="lc-consent-summary" aria-live="polite">${consentSummaryHtml(L)}</div>
          <div class="lc-error" id="lc-lobby-err" role="alert">${L.error ? esc(tr(L.error)) : ''}</div>
          <button type="button" class="lc-btn lc-primary lc-join" data-lc="join" id="lc-join">Join class</button>
          <p class="lc-fine">No emotion detection. Speakers are identified by their own microphone, never by voiceprint. You can turn recording off at any time from your profile menu.</p>
        </section>
      </div>
      ${declineModalHtml()}
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

  function afterLobbyRender() { startPreview(); if (S.lobby && S.lobby.cstate === 'loading') initLobbyConsent(S.lobby); }

  function syncConsentUi() {
    const L = S.lobby; if (!L) return;
    const g = document.getElementById('lc-guardian'); if (g) g.hidden = !L.minor;
    const sum = document.getElementById('lc-consent-summary'); if (sum) sum.innerHTML = consentSummaryHtml(L);
    const pi = document.getElementById('lc-preview-initials'); if (pi) { pi.textContent = initials(L.name || 'You'); pi.style.background = colorFor(L.name || 'you'); }
  }
  // under 18: name + valid email + the student's declaration, all required for the "yes" to count (unless the institution manages it)
  function guardianError(G, P) {
    if (!G.minor || managedConsent()) return null;
    if (!G.guardian.name.trim()) return { msg: "Please write the guardian's name.", focus: P + 'g-name' };
    if (!EMAIL_RE.test(G.guardian.email.trim())) return { msg: 'Please write a valid guardian email.', focus: P + 'g-email' };
    if (currentUser && String(currentUser.email || '').toLowerCase() === G.guardian.email.trim().toLowerCase()) return { msg: "The guardian's email must be different from yours.", focus: P + 'g-email' };
    if (!G.guardian.consent) return { msg: 'Check the box to declare that your parent or guardian agrees.', focus: P + 'g-consent' };
    return null;
  }
  function setLobbyError(msg) {
    const L = S.lobby; if (L) L.error = msg;
    const el = document.getElementById('lc-lobby-err'); if (el) el.textContent = msg ? tr(msg) : '';
  }

  async function joinFromLobby() {
    const L = S.lobby;
    L.name = String(L.name || (currentUser && (currentUser.name || String(currentUser.email || '').split('@')[0])) || tr('Participant')).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (L.cstate === 'loading') { setLobbyError('Checking your recording consent…'); return; }
    if (L.cstate === 'ask' && !inViewAs()) {
      if (!L.agree) { setLobbyError(''); openDecline(); return; }   // a "no" needs a justification first
      const gErr = guardianError(L, 'lc-');
      if (gErr) { setLobbyError(gErr.msg); document.getElementById(gErr.focus)?.focus(); return; }
      try {
        const d = await grantConsent(L);
        if (S.lobby !== L) return;
        if (!consentOk(d)) throw new Error('Could not save your consent.');
        L.cstate = 'granted'; L.recorded = !!d.recorded; L.guardianOkDb = !!d.guardian_consent;
      } catch (e) { setLobbyError(dbMsg(e) || 'Could not save your consent.'); return; }
    }
    if (inViewAs()) L.recorded = false;
    setLobbyError('');
    const btn = document.getElementById('lc-join'); if (btn) { btn.disabled = true; btn.textContent = tr('Connecting…'); }
    stopMeter();
    await enterRoom();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // ROOM
  // ════════════════════════════════════════════════════════════════════════════════════════
  const recorderOn = () => typeof APP_CONFIG !== 'undefined' && APP_CONFIG.recording === true;
  // "● Recording" only once a recording really started for that person: with LiveKit the SERVER says so (rec_active in their
  // metadata, set after the egress started — api/_lib/rec/pipeline.js); the demo simulates it for everyone who consented.
  const recActive = p => !!p && (S.room && S.room.kind === 'livekit' ? !!p.recActive : !!p.recorded);
  const recLive = R => recorderOn() && (R.participants || []).some(recActive);
  const roomOwnerKey = () => String(currentUser?.id || 'guest').replace(/-/g, '').slice(0, 12).toLowerCase();
  const randId = () => Math.random().toString(36).slice(2, 10);
  const isNarrow = () => window.matchMedia && window.matchMedia('(max-width: 900px)').matches;

  async function enterRoom() {
    const L = S.lobby;
    let kind = await detectProviderKind();
    // P-06: the plan attached to this calendar class; a calendar class without a plan shows none (no invented sample);
    // only the free "Start live class" with "Sample plan (demo)" uses a sample
    const planText = (S.planning && S.planning.content) || (S.demo ? (S.sampleKey === 'chemistry' ? SAMPLE_PLAN_ES : SAMPLE_PLAN_EN) : (S.sessionTitle || ''));
    const plan = parsePlanSections(planText, parseInt(S.planning?.params?.duration, 10) || 45);
    plan.sections.forEach(s => { s.elapsed = 0; });
    // consent from the database (lobby): the LiveKit token reads it there too, never from this browser
    const recorded = L.cstate === 'granted' && !!L.recorded && !inViewAs();
    const minor = recorded && !!L.minor;
    const R = {
      kind, provider: null, role: L.role, name: L.name, stream: L.stream, screen: null,
      mic: L.mic && !!L.stream?.getAudioTracks().length, cam: L.cam && !!L.stream?.getVideoTracks().length,
      recorded, minor, guardianOk: minor && !!L.guardianOkDb,
      // AUTO-RECORDING: on from the moment the room is live (only people who consented; audio only)
      hand: false, rec: { state: 'on', secs: 0, resumeAt: 0 }, secs: 0, remoteScreens: [],
      chat: [], unread: 0, side: isNarrow() ? null : (L.role === 'teacher' ? 'plan' : 'chat'),
      speaking: new Set(), talk: { teacher: 0, students: 0 }, plan, running: -1, participants: [],
      // A calendar session → one room for its teacher and students. TODO(live): api/_lib/class/token.js grants
      // roomAdmin by "<ownerKey>-…" rooms; with real LiveKit, look the session up (teacher → admin) instead.
      roomName: S.sessionId ? `sess-${String(S.sessionId).replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`
        : S.adhocRoom ? S.adhocRoom
        : `${roomOwnerKey()}-${S.planning?.id ? String(S.planning.id).replace(/-/g, '').slice(0, 10) : randId()}`,
      endOpen: false,
    };
    const connectOpts = provider => ({
      room: R.roomName, name: R.name, role: R.role, recorded, minor: R.minor, guardianOk: R.guardianOk,
      localStream: R.stream, mic: R.mic, cam: R.cam, provider, title: S.sessionTitle,
      simulate: !!S.demo || inViewAs(), teacherName: S.teacherName || '', ticket: S.ticket || null,
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
    if (!R.recorded) toast('You joined without being recorded.', 'ok');
    // Attendance (public/attendance.js): a calendar class records who entered (students: present / late; the teacher too).
    // TODO(live): with real LiveKit, its webhook (participant_joined / left) also feeds attendance_record_external.
    if (S.sessionId && window.TCAttendance) { R.attendance = true; window.TCAttendance.roomJoin(S.sessionId); }
    // the class started: its section of the group notebook exists from now on (public/group-notebook.js; one-off classes: none)
    if (S.sessionId && window.TCNotebook) window.TCNotebook.ensureSession(S.sessionId);
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
      const was = R.rec.state; R.rec.state = state;
      if (state === 'paused') { if (was !== 'paused' || !R.rec.resumeAt) R.rec.resumeAt = Date.now() + PAUSE_MAX_S * 1000; }
      else R.rec.resumeAt = 0;
      if (S.room !== R) return;
      if (R.role !== 'teacher' && was !== state) toast(state === 'paused' ? 'The teacher paused the recording. It resumes automatically.' : state === 'on' ? 'Recording resumed' : 'Recording stopped');
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
    p.on('audioblocked', blocked => { R.audioBlocked = !!blocked; if (S.room === R) showAudioUnlock(R); });
    p.on('disconnected', () => { if (S.room === R && S.view === 'room') { toast('You were disconnected.', 'err'); } });
  }

  function ctl(id, act, icon, label, extra = '') {
    return `<button type="button" class="lc-ctl" id="lc-ctl-${id}" data-lc="${act}" ${extra}><span class="lc-ctl-ic" aria-hidden="true">${icon}</span><span class="lc-ctl-lb">${label}</span></button>`;
  }
  function roomHtml() {
    const R = S.room; const teacher = R.role === 'teacher';
    return `<div class="lc-room${R.side ? ' side-open' : ''}" id="lc-room">
      <div class="lc-room-top">
        <div class="lc-room-title">${S.demo ? demoChip() : ''} <b data-no-i18n>${esc(S.sessionTitle)}</b> <span class="lc-chip" id="lc-provider-chip">${R.kind === 'livekit' ? 'LiveKit' : S.demo ? 'Simulated participants' : 'Preview mode'}</span>${R.role === 'teacher' && !S.sessionId && !S.demo ? ' <button type="button" class="lc-btn lc-sm" data-lc="invite-link" id="lc-invite-link">🔗 <span>Invite students</span></button>' : ''}</div>
        <div class="lc-rec" id="lc-rec" data-state="${esc(R.rec.state)}" data-recorder="${recorderOn() ? 'on' : 'off'}" role="status"><span class="lc-rec-dot" aria-hidden="true"></span><span class="lc-rec-label" aria-live="polite">${recLive(R) ? 'Recording — only people who gave consent' : 'Recording ready to be turned on — nothing is recorded yet'}</span><span class="lc-rec-time" data-no-i18n id="lc-rec-time"></span><span class="lc-rec-me" id="lc-rec-me"${R.recorded ? ' hidden' : ''}>You: not recorded</span></div>
        <div class="lc-talk" id="lc-talk" role="group" aria-label="${esc(tr('Talk time'))}">
          <span class="lc-talk-lb">Teacher</span> <b data-no-i18n id="lc-talk-t">0%</b>
          <div class="lc-talk-bar" aria-hidden="true"><span id="lc-talk-bar-t"></span></div>
          <b data-no-i18n id="lc-talk-s">0%</b> <span class="lc-talk-lb">Students</span>
        </div>
        <div class="lc-clock" data-no-i18n id="lc-clock" aria-label="${esc(tr('Class time'))}">00:00</div>
      </div>
      ${S.demo ? banner(true) : ''}
      <div class="lc-room-body">
        <div class="lc-stage"><div class="lc-grid" id="lc-grid"></div></div>
        <aside class="lc-side" id="lc-side" aria-label="${esc(tr('Side panel'))}">
          <div class="lc-side-grip" id="lc-side-grip" role="separator" aria-orientation="vertical" tabindex="0" aria-valuemin="${SIDE_MIN}" aria-valuemax="${SIDE_MAX}" aria-valuenow="${SIDE_DEF}" aria-label="${esc(tr('Drag to resize the panel'))}" hidden></div>
          <div class="lc-side-tabs" role="tablist">
            <button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="plan" id="lc-tab-plan">Class plan</button>
            <button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="chat" id="lc-tab-chat">Chat</button>
            <button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="people" id="lc-tab-people">People</button>
            ${S.sessionId && window.TCClassDoc ? '<button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="doc" id="lc-tab-doc">Document</button>' : ''}
            ${S.sessionId && window.TCClassBoard ? '<button type="button" role="tab" class="lc-side-tab" data-lc="side" data-side="board" id="lc-tab-board">Board</button>' : ''}
            <button type="button" class="lc-side-size" id="lc-side-size" data-lc="side-size" aria-pressed="false" hidden><span aria-hidden="true">⤢</span> <span class="lc-side-size-lb">Bigger</span></button>
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
          ${S.sessionId && window.TCClassBoard ? '<div class="lc-side-body lc-board-body" id="lc-side-board" role="tabpanel" aria-labelledby="lc-tab-board" hidden></div>' : ''}
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
          ${S.sessionId && window.TCClassBoard ? ctl('board', 'side', '🖍️', 'Board', 'data-side="board"') : ''}
        </div>
        <div class="lc-ctl-group">
          ${teacher ? ctl('pause', 'rec-pause', '⏸', 'Pause recording') : ''}
          <button type="button" class="lc-ctl lc-end" id="lc-ctl-end" data-lc="${teacher ? 'end' : 'leave'}"><span class="lc-ctl-ic" aria-hidden="true">⏹</span><span class="lc-ctl-lb">${teacher ? 'End class' : 'Leave'}</span></button>
        </div>
      </div>
      <div class="lc-modal-bg" id="lc-end-modal" hidden>
        <div class="lc-modal" role="dialog" aria-modal="true" aria-labelledby="lc-end-h">
          <h2 id="lc-end-h">End the class for everyone?</h2>
          <p>The call ends for all participants and the recording stops. Insights are prepared next.</p>
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
    if (S.room) watchStage(S.room);
  }

  function consentBadge(p) {
    if (p.recorded) return `<span class="lc-badge rec" title="${esc(tr('Consented to recording'))}">● <span>${recorderOn() && recActive(p) ? 'Recorded' : 'Consented'}</span></span>${p.minor ? ` <span class="lc-badge" title="${esc(tr('Under 18: guardian consent declared by the student or managed by the institution (not verified by TeroClass)'))}">👪 <span>Under 18</span></span>` : ''}`;
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
  // what a tile shows (anything else is updated in place by updateTiles): same signature → the element (and its video) is kept
  const tileSig = p => [p.name, p.role, p.isLocal ? 1 : 0, p.recorded ? 1 : 0, p.minor ? 1 : 0, recorderOn() && recActive(p) ? 1 : 0, S.room.kind].join('|');
  // students see the teacher first, then themselves, then classmates; the teacher sees the students first and their own tile last
  function orderedPeople(R) {
    const list = R.participants.length ? R.participants : [{ id: 'local', isLocal: true, name: R.name, role: R.role, mic: R.mic, cam: R.cam, recorded: R.recorded, minor: R.minor }];
    const t = list.filter(p => p.role === 'teacher' && !p.isLocal), me = list.filter(p => p.isLocal), rest = list.filter(p => !p.isLocal && p.role !== 'teacher');
    return R.role === 'teacher' ? [...t, ...rest, ...me] : [...t, ...me, ...rest];
  }
  // 2026-10-29: the grid is rebuilt by KEY (participant id / screen): unchanged tiles keep their element and their video, so
  // a participants event (mic, hand, someone joining) never re-attaches every track. Layout = absolute rectangles (layoutStage).
  function renderGrid() {
    const R = S.room; const g = document.getElementById('lc-grid'); if (!R || !g) return;
    const items = (R.remoteScreens || []).map(sc => ({ key: 'screen-' + sc.id, sig: 'rs|' + sc.name,
      html: () => `<div class="lc-tile lc-share-tile remote" data-pid="screen-${esc(sc.id)}" role="group" aria-label="${esc(sc.name)}"><video class="lc-video" data-screen="${esc(sc.id)}" autoplay muted playsinline></video><div class="lc-tile-bar"><span aria-hidden="true">🖥️</span> <span data-no-i18n>${esc(sc.name)}</span> <span>is presenting</span></div></div>` }));
    if (R.screen) items.push({ key: 'screen', sig: 'ls', html: () => `<div class="lc-tile lc-share-tile" data-pid="screen"><video class="lc-video" id="lc-share-video" autoplay muted playsinline></video><div class="lc-tile-bar"><span aria-hidden="true">🖥️</span> <span>You are presenting</span> <button type="button" class="lc-btn lc-sm" data-lc="share">Stop sharing</button></div></div>` });
    const people = orderedPeople(R);
    people.forEach(p => items.push({ key: p.id, sig: tileSig(p), html: () => tileHtml(p) }));
    const old = new Map($$(':scope > .lc-tile', g).map(el => [el.dataset.pid, el]));
    let prev = null;
    items.forEach(it => {
      let el = old.get(it.key);
      if (el && el.dataset.sig === it.sig) old.delete(it.key);
      else {
        if (el) { el.remove(); old.delete(it.key); }
        const t = document.createElement('div'); t.innerHTML = it.html().trim(); el = t.firstElementChild;
        el.dataset.sig = it.sig; el.classList.add('lc-new');
      }
      const want = prev ? prev.nextElementSibling : g.firstElementChild;
      if (want !== el) g.insertBefore(el, want);
      prev = el;
    });
    old.forEach(el => el.remove());
    g.dataset.count = String(people.length + (R.screen ? 1 : 0) + (R.remoteScreens || []).length);
    $$('video[data-screen]', g).forEach(v => { try { R.provider?.attachScreen(v.dataset.screen, v); } catch (e) { /* ignore */ } });
    const lv = document.getElementById('lc-local-video'); if (lv && R.stream && R.stream.getVideoTracks().length && lv.srcObject !== R.stream) lv.srcObject = R.stream;
    const sv = document.getElementById('lc-share-video'); if (sv && R.screen && sv.srcObject !== R.screen) sv.srcObject = R.screen;
    if (R.kind === 'livekit') $$('.lc-tile[data-pid] video.lc-video', g).forEach(v => { const id = v.closest('.lc-tile').dataset.pid; if (id !== 'local' && !id.startsWith('screen')) R.provider?.attachVideo(id, v); });
    layoutStage();
    updateTiles();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // STAGE LAYOUT (2026-10-29). Every tile is placed in an absolute rectangle computed from the stage size:
  //   • 1 person: one large tile.  • 2 people: "speaker focus": the OTHER person fills the stage, me in a picture-in-picture
  //     (bottom-right; drag it to another corner).  • 3+: the grid that gives the biggest tiles without scrolling (columns ×
  //     rows from the count and the stage shape); phones: 1–2 columns and scrolling.  • A shared screen: large, people in a
  //     strip beside it (or below it on narrow stages).  Board / Document open on a desktop: the panel is wide and the videos
  //     become a column (same grid rule on the narrow stage). A ResizeObserver on the stage recomputes; nothing is re-attached.
  // ════════════════════════════════════════════════════════════════════════════════════════
  const GAP = 10, TILE_AR = 16 / 10, SHARE_AR = 16 / 9;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode: not remembered */ } };
  const PIP_CORNERS = ['br', 'bl', 'tr', 'tl'];
  const pipCorner = () => { const c = lsGet('tc_lc_pip'); return PIP_CORNERS.includes(c) ? c : 'br'; };
  // the biggest tile width for n tiles of aspect ar in W×H (cols 1..maxCols)
  function fitGrid(n, W, H, ar, maxCols) {
    let best = { cols: 1, w: 0 };
    for (let c = 1; c <= Math.min(n, maxCols || n); c++) {
      const r = Math.ceil(n / c);
      const w = Math.min((W - (c - 1) * GAP) / c, ((H - (r - 1) * GAP) / r) * ar);
      if (w > best.w + 0.5) best = { cols: c, w };
    }
    return best;
  }
  // places list in a centered grid inside (x0,y0,W,H); returns the height used (can exceed H → the stage scrolls)
  function placeGrid(rects, list, x0, y0, W, H, ar, opt = {}) {
    const n = list.length; if (!n) return 0;
    let { cols, w } = fitGrid(n, W, H, ar, opt.maxCols);
    if (opt.minW && w < opt.minW) { cols = clamp(Math.floor((W + GAP) / (opt.minW + GAP)), 1, Math.min(n, opt.maxCols || n)); w = (W - (cols - 1) * GAP) / cols; }
    if (opt.maxW) w = Math.min(w, opt.maxW);
    const h = w / ar, rows = Math.ceil(n / cols), gridH = rows * h + (rows - 1) * GAP;
    const top = y0 + Math.max(0, (H - gridH) / 2);
    list.forEach((el, i) => {
      const r = Math.floor(i / cols), c = i % cols, inRow = r === rows - 1 ? n - r * cols : cols;
      const left = x0 + (W - (inRow * w + (inRow - 1) * GAP)) / 2 + c * (w + GAP);
      rects.set(el, { x: left, y: top + r * (h + GAP), w, h });
    });
    return Math.max(0, top - y0) + gridH;
  }
  function layoutStage() {
    const R = S.room; const g = document.getElementById('lc-grid'); const st = g && g.parentElement; const room = document.getElementById('lc-room');
    if (!R || !g || !st || !room) return;
    const cs = getComputedStyle(st);
    const W = Math.floor(st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const H = Math.floor(st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    if (W <= 0 || H <= 0) return; // hidden (board full screen) or not laid out yet
    const tiles = $$(':scope > .lc-tile', g);
    const shares = tiles.filter(t => t.classList.contains('lc-share-tile'));
    const people = tiles.filter(t => !t.classList.contains('lc-share-tile'));
    const phone = W < 600, wide = room.classList.contains('side-wide');
    const rects = new Map(); let used = H; let layout;
    if (shares.length) {
      layout = 'share';
      if (!people.length) used = placeGrid(rects, shares, 0, 0, W, H, SHARE_AR);
      else if (wide || phone || W / H < 1.3) { // the screen on top, people in rows below
        const sh = phone ? 84 : clamp(H * 0.2, 96, 150); const pw = sh * TILE_AR;
        placeGrid(rects, shares, 0, 0, W, H - sh - GAP, SHARE_AR);
        const per = Math.max(1, Math.floor((W + GAP) / (pw + GAP)));
        people.forEach((el, i) => {
          const r = Math.floor(i / per), c = i % per, inRow = Math.min(per, people.length - r * per);
          rects.set(el, { x: (W - (inRow * pw + (inRow - 1) * GAP)) / 2 + c * (pw + GAP), y: H - sh + r * (sh + GAP), w: pw, h: sh });
        });
        used = H + (Math.ceil(people.length / per) - 1) * (sh + GAP);
      } else { // the screen on the left, people in a column on the right
        const sw = clamp(W * 0.17, 150, 240), sh = sw / TILE_AR;
        placeGrid(rects, shares, 0, 0, W - sw - GAP, H, SHARE_AR);
        const colH = people.length * sh + (people.length - 1) * GAP, top = Math.max(0, (H - colH) / 2);
        people.forEach((el, i) => rects.set(el, { x: W - sw, y: top + i * (sh + GAP), w: sw, h: sh }));
        used = Math.max(H, colH);
      }
    } else if (people.length === 2 && !wide) {
      layout = 'duo';
      const me = people.find(t => t.dataset.pid === 'local') || people[1];
      const other = people.find(t => t !== me);
      rects.set(other, { x: 0, y: 0, w: W, h: H });
      const pw = Math.round(clamp(W * (phone ? 0.3 : 0.21), 96, 320)), ph = Math.round(pw / TILE_AR), m = phone ? 10 : 14;
      const c = pipCorner();
      rects.set(me, { x: c[1] === 'r' ? W - pw - m : m, y: c[0] === 'b' ? H - ph - m : m, w: pw, h: ph });
      other.classList.add('lc-main'); me.classList.add('lc-pip');
    } else {
      layout = people.length === 1 ? 'solo' : 'grid';
      used = placeGrid(rects, people, 0, 0, W, H, TILE_AR, phone ? { maxCols: 2, minW: 140 } : { minW: 150 });
    }
    if (layout !== 'duo') people.forEach(t => t.classList.remove('lc-main', 'lc-pip'));
    g.dataset.layout = layout;
    g.style.height = Math.ceil(Math.max(H, used)) + 'px';
    st.classList.toggle('lc-scroll', used > H + 1);
    tiles.forEach(t => {
      const r = rects.get(t); if (!r) return;
      const set = (k, v) => { const px = Math.round(v) + 'px'; if (t.style[k] !== px) t.style[k] = px; };
      set('left', r.x); set('top', r.y); set('width', r.w); set('height', r.h);
    });
    // new tiles appear in place (no slide from the corner); later moves are animated
    const fresh = tiles.filter(t => t.classList.contains('lc-new'));
    if (fresh.length) requestAnimationFrame(() => requestAnimationFrame(() => fresh.forEach(t => t.classList.remove('lc-new'))));
  }
  // the stage changes size (window, side panel, phone rotation) → recompute rectangles only
  function watchStage(R) {
    const st = document.querySelector('#lc-room .lc-stage'); if (!st || !window.ResizeObserver) return;
    let raf = 0;
    R.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (S.room === R) { syncSideWide(); layoutStage(); } }); });
    R.ro.observe(st);
  }
  // picture-in-picture: drag it to another corner (remembered in this browser)
  function onPipDown(e) {
    const t = e.target.closest('.lc-tile.lc-pip'); if (!t || e.button > 0 || e.target.closest('button')) return;
    const g = t.parentElement; const x0 = e.clientX, y0 = e.clientY; let moved = false;
    try { t.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    t.classList.add('dragging');
    const move = ev => { const dx = ev.clientX - x0, dy = ev.clientY - y0; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; t.style.transform = `translate(${dx}px,${dy}px)`; };
    const up = ev => {
      t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up);
      t.classList.remove('dragging'); t.style.transform = '';
      if (!moved) return;
      const gr = g.getBoundingClientRect(), tr = t.getBoundingClientRect();
      const cx = tr.left + tr.width / 2 + (ev.clientX - x0), cy = tr.top + tr.height / 2 + (ev.clientY - y0);
      lsSet('tc_lc_pip', (cy > gr.top + gr.height / 2 ? 'b' : 't') + (cx > gr.left + gr.width / 2 ? 'r' : 'l'));
      layoutStage();
    };
    t.addEventListener('pointermove', move); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
  }
  // Board / Document on a desktop: a wide side panel (58% by default, up to 75%), remembered in this browser
  const SIDE_MIN = 40, SIDE_DEF = 58, SIDE_MAX = 75;
  const sideWidth = () => { const v = parseFloat(lsGet('tc_lc_side_w')); return Number.isFinite(v) ? clamp(v, SIDE_MIN, SIDE_MAX) : SIDE_DEF; };
  function syncSideWide() {
    const R = S.room; const room = document.getElementById('lc-room'); if (!R || !room) return false;
    const wide = (R.side === 'board' || R.side === 'doc') && !isNarrow();
    const was = room.classList.contains('side-wide');
    room.classList.toggle('side-wide', wide);
    const w = sideWidth(); room.style.setProperty('--lc-side-w', w + '%');
    const b = document.getElementById('lc-side-size');
    if (b) {
      b.hidden = !wide;
      const big = w >= SIDE_MAX - 1; const k = big ? 'Smaller' : 'Bigger';
      const lb = b.querySelector('.lc-side-size-lb'); if (lb && lb.dataset.k !== k) { lb.dataset.k = k; lb.textContent = k; }
      b.setAttribute('aria-pressed', String(big));
      b.title = tr(big ? 'Make the panel smaller' : 'Make the panel bigger');
    }
    const grip = document.getElementById('lc-side-grip'); if (grip) { grip.hidden = !wide; grip.setAttribute('aria-valuenow', String(Math.round(w))); }
    return was !== wide;
  }
  function setSideWidth(v) { lsSet('tc_lc_side_w', String(Math.round(clamp(v, SIDE_MIN, SIDE_MAX)))); syncSideWide(); layoutStage(); }
  function onGripDown(e) {
    const grip = e.target.closest('#lc-side-grip'); if (!grip || e.button > 0) return;
    const body = document.querySelector('#lc-room .lc-room-body'); if (!body) return;
    e.preventDefault(); try { grip.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    const room = document.getElementById('lc-room'); room.classList.add('resizing');
    const pct = ev => { const r = body.getBoundingClientRect(); return clamp((r.right - ev.clientX) / r.width * 100, SIDE_MIN, SIDE_MAX); };
    const move = ev => room.style.setProperty('--lc-side-w', pct(ev) + '%');
    const up = ev => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); room.classList.remove('resizing'); setSideWidth(pct(ev)); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // ROOM BACKGROUND set by the institution (Branding → "Classroom"; 001_base.sql "ROOM BRANDING"): a color, an uploaded
  // image (our storage bucket only) or the default light one, inherited by branches. Lobby + room, for everyone in the class.
  // ════════════════════════════════════════════════════════════════════════════════════════
  const ROOM_BG_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/storage\/v1\/object\/public\/room-backgrounds\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}\.(jpe?g|png|webp)$/i;
  function cleanRoomBg(b) {
    if (b && b.kind === 'color' && /^#[0-9a-f]{6}$/i.test(b.color || '')) return { kind: 'color', color: b.color.toLowerCase() };
    if (b && b.kind === 'image' && ROOM_BG_URL_RE.test(b.image_url || '')) return { kind: 'image', url: b.image_url };
    return { kind: 'default' };
  }
  let roomBgSeq = 0;
  async function loadRoomBg(key) {
    const seq = ++roomBgSeq;
    let b = null;
    try {
      if (typeof sb !== 'undefined' && currentUser) {
        const { data, error } = await sb.rpc('get_room_background', S.sessionId ? { p_session: S.sessionId } : {});
        if (!error) b = data;
      }
    } catch (e) { /* the default background */ }
    if (seq !== roomBgSeq) return;
    S.roomBg = { key, ...cleanRoomBg(b) }; S.roomBgLoading = null;
    syncRoomBg();
  }
  function syncRoomBg() {
    const el = root(); if (!el) return;
    const on = S.view === 'lobby' || S.view === 'room';
    const key = (currentUser?.id || '-') + ':' + (S.sessionId || '-');
    if (on && S.roomBg?.key !== key && S.roomBgLoading !== key) { S.roomBgLoading = key; loadRoomBg(key); }
    const b = on && S.roomBg ? S.roomBg : { kind: 'default' };
    if (el.dataset.roombg !== b.kind) el.dataset.roombg = b.kind;
    el.style.setProperty('--lc-room-color', b.kind === 'color' ? b.color : '');
    el.style.setProperty('--lc-room-img', b.kind === 'image' ? `url("${b.url}")` : '');
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
    box.innerHTML = R.chat.length ? R.chat.map(m => `<div class="lc-msg${m.self ? ' self' : ''}"><div class="lc-msg-head"><b data-no-i18n>${esc(m.self ? R.name : m.name)}</b> <span data-no-i18n>${esc(new Date(m.ts).toLocaleTimeString(typeof uiLocale === 'function' ? uiLocale() : undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))}</span></div><div class="lc-msg-text" data-no-i18n>${esc(m.text)}</div></div>`).join('')
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
        ${S.planning ? '' : S.sessionId ? '<div class="lc-hint" id="lc-plan-none">No plan attached to this class. Attach a saved class from this class in the Calendar.</div>' : S.demo ? '<div class="lc-hint">Sample plan — open a saved class to see yours here.</div>' : '<div class="lc-hint" id="lc-plan-none">No plan for this room. Choose a saved class when you start it.</div>'}
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
    room.classList.toggle('board-open', R.side === 'board');
    room.classList.toggle('board-full', R.side === 'board' && !!R.boardFull);
    const sideKey = (R.side || '') + '|' + !!R.boardFull;
    if (syncSideWide() | (R._sideKey !== sideKey)) { R._sideKey = sideKey; layoutStage(); }
    // side panel tabs
    ['plan', 'chat', 'people', 'doc', 'board'].forEach(k => {
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
    const pb = document.getElementById('lc-ctl-pause');
    if (pb) { pb.hidden = st === 'off'; setCtl('pause', st === 'paused', st === 'paused' ? '▶' : '⏸', st === 'paused' ? 'Resume' : 'Pause recording', false); pb.classList.toggle('rec-paused', st === 'paused'); }
    // recording indicator: always visible to everyone (auto-recording)
    const rec = document.getElementById('lc-rec');
    if (rec) {
      rec.dataset.state = st;
      const lb = rec.querySelector('.lc-rec-label');
      // TC-23: "Recording" only when a recorder is really connected (RECORDING_ENABLED); otherwise say it is ready
      const k = st === 'on' ? (recLive(R) ? 'Recording — only people who gave consent' : 'Recording ready to be turned on — nothing is recorded yet')
        : st === 'paused' ? 'Recording paused — resumes automatically' : 'Not recording';
      if (lb.dataset.k !== k) { lb.dataset.k = k; lb.textContent = k; }
      const t = document.getElementById('lc-rec-time');
      if (t) t.textContent = st === 'paused' && R.rec.resumeAt ? mmss((R.rec.resumeAt - Date.now()) / 1000) : '';
      const me = document.getElementById('lc-rec-me'); if (me) me.hidden = !!R.recorded || st === 'off';
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
    // a pause resumes by itself (the teacher's browser sends it to everyone)
    if (R.rec.state === 'paused' && R.rec.resumeAt && Date.now() >= R.rec.resumeAt && R.role === 'teacher' && !R.resuming) {
      R.resuming = true;
      Promise.resolve(R.provider.setRecording('on')).catch(e => console.warn(e)).finally(() => { R.resuming = false; });
      toast('Recording resumed automatically', 'ok');
    }
    const speakers = R.participants.filter(p => R.speaking.has(p.id) && (p.isLocal ? R.mic : p.mic));
    if (speakers.some(p => p.role === 'teacher')) R.talk.teacher++;
    else if (speakers.length) R.talk.students++;
    if (R.running >= 0) R.plan.sections[R.running].elapsed++;
    updateRoomUi();
  }

  // 2026-10-29: "I can't hear the student" → a big button when the browser blocked the sound
  function showAudioUnlock(R) {
    let b = document.getElementById('lc-audio-unlock');
    if (!R.audioBlocked || S.room !== R) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement('button');
    b.type = 'button'; b.id = 'lc-audio-unlock'; b.className = 'lc-audio-unlock';
    b.textContent = '🔊 ' + tr('Click here to hear the class');
    b.addEventListener('click', async () => { await R.provider.startAudio(); R.audioBlocked = false; b.remove(); });
    document.body.appendChild(b);
  }
  // the microphone was blocked or missing in the lobby → ask for it now instead of a dead button
  async function enableMicLate(R) {
    let s = null;
    try { s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) {
      toast(e && e.name === 'NotAllowedError'
        ? 'Your browser is blocking the microphone. Click the lock next to the address, allow the microphone and join again.'
        : mediaErrorText(e), 'err');
      return;
    }
    if (S.room !== R) { stopStream(s); return; }
    const [t] = s.getAudioTracks();
    if (!R.stream) R.stream = new MediaStream();
    R.stream.addTrack(t);
    try { await R.provider.publishMic(t); R.mic = true; toast('Microphone on', 'ok'); } catch (e) { console.warn(e); toast('Could not turn on the microphone. Leave and join the class again.', 'err'); }
    updateRoomUi(); updateTiles();
  }

  async function toggleMic() {
    const R = S.room;
    if (R.provider && R.provider.startAudio) R.provider.startAudio().catch(() => {});
    if (!R.stream?.getAudioTracks().length) { await enableMicLate(R); return; }
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
  // Teacher: pause for a private moment / resume. A pause resumes by itself after PAUSE_MAX_S (roomTick).
  async function togglePause() {
    const R = S.room; if (R.role !== 'teacher' || R.rec.state === 'off') return;
    const next = R.rec.state === 'paused' ? 'on' : 'paused';
    if (next === 'paused') R.rec.resumeAt = Date.now() + PAUSE_MAX_S * 1000;
    await R.provider.setRecording(next);
    R.rec.state = next; if (next === 'on') R.rec.resumeAt = 0;
    toast(next === 'paused' ? 'Recording paused. It resumes automatically in 5 minutes.' : 'Recording resumed', 'ok');
    updateRoomUi();
  }
  function setSide(k) {
    const R = S.room; R.side = R.side === k && document.activeElement?.closest('.lc-controls') ? null : k;
    if (R.side === 'chat') { R.unread = 0; renderChat(); setTimeout(() => document.getElementById('lc-chat-input')?.focus(), 30); }
    updateRoomUi();
    // the GROUP NOTEBOOK on this class's section (public/group-notebook.js; a one-off class without a group: its class document,
    // public/class-doc.js), mounted the first time the tab opens; it keeps syncing while in the room
    if (R.side === 'doc' && !R.doc && S.sessionId && (window.TCNotebook || window.TCClassDoc)) {
      const host = document.getElementById('lc-side-doc');
      if (host) { R.doc = 'loading'; (window.TCNotebook ? window.TCNotebook.mount(host, S.sessionId) : window.TCClassDoc.mount(host, S.sessionId)).then(v => { if (S.room === R) R.doc = v; else if (v) v.destroy(); }); }
    }
    // the class whiteboard (public/class-board.js), same: mounted the first time its tab opens; "Full screen" covers the stage
    if (R.side === 'board' && !R.board && S.sessionId && window.TCClassBoard) {
      const host = document.getElementById('lc-side-board');
      if (host) {
        R.board = 'loading';
        // a class of a group: the group board with a page per class, opened on this class's page ("Today")
        window.TCClassBoard.mount(host, S.sessionId, { onExpand: full => { if (S.room === R) { R.boardFull = !!full; updateRoomUi(); } }, onSwap: v => { if (S.room === R) R.board = v; } })
          .then(v => { if (S.room === R) R.board = v; else if (v) v.destroy(); });
      }
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
    if (R.board && R.board !== 'loading') { try { R.board.close(); } catch (e) { /* ignore */ } }
    if (window.TCAttendance && R.attendance) window.TCAttendance.roomLeave();
    if (R.ro) { try { R.ro.disconnect(); } catch (e) { /* ignore */ } R.ro = null; }
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
      recorded: R.rec.secs > 0 && R.participants.some(p => p.recorded), recSecs: R.rec.secs, secs: R.secs, participants: R.participants.length,
      recordedCount: R.participants.filter(p => p.recorded).length, talk: { ...R.talk }, role: R.role,
      plan: R.plan.sections.map(s => ({ title: s.generic ? '' : s.title, planned: s.minutes, actual: Math.round(s.elapsed / 60) })),
    };
    const sess = S.sessionId && R.role === 'teacher' && S.sessionRole !== 'student' ? { id: S.sessionId, title: S.sessionTitle, group: S.sessionGroup } : null;
    // REAL recording (pipeline configured + LiveKit + a calendar class): the server ends the class for everyone and prepares
    // the real insights; nothing simulated and no demo insights are stored for it
    const real = !!sess && R.kind === 'livekit' && recorderOn() && !S.demo && typeof R.provider?.endForAll === 'function';
    if (real) R.provider.endForAll();
    teardownRoom();
    // the class document keeps a "class end" version (teacher / substitute; nothing is created if nobody wrote)
    if (sess && typeof sb !== 'undefined') sb.rpc('classdoc_add_version', { p_session: sess.id, p_label: 'class_end' }).then(() => {}, () => {});
    // … and so does the class whiteboard (nothing is created if nobody drew)
    if (sess && typeof sb !== 'undefined') sb.rpc('classboard_add_version', { p_session: sess.id, p_label: 'class_end' }).then(() => {}, () => {});
    // … and the group notebook (a version of the whole notebook labelled "end of class")
    if (sess && window.TCNotebook) window.TCNotebook.classEnd(sess.id);
    // P-07 / P-08: sample insights only for the explicit demo; a calendar class gets its (demo-flagged) stored insights;
    // a quick room outside the calendar (or a student) gets none — nothing invented is shown as if it were real
    if (real) {
      S.view = 'home'; render();
      toast('Class ended. Processing your class… (it may take a few minutes)', 'ok');
      if (window.TCInsightsPanel) window.TCInsightsPanel.openSession(sess.id, { from: 'live' });
      return;
    }
    if (!S.demo && !sess) {
      S.view = 'home'; S.adhocRoom = null; S.ticket = null; render();
      toast(R.role === 'teacher' ? 'Class ended. Insights are prepared for the classes scheduled in the Calendar.' : 'You left the class.', 'ok');
      return;
    }
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
      const payload = V.buildDemoPayload({ key: S.planning ? null : S.sampleKey, title: sess.title, group: sess.group, plan: (S.planning && S.planning.content) || '' });
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
  // ── TC-13: invitation link of a quick room (only its creator; needs the real video classroom) ──
  async function inviteLink(btn) {
    const R = S.room; if (!R || R.role !== 'teacher' || S.sessionId) return;
    if (inViewAs()) { if (typeof vaBlocked === 'function') vaBlocked(); return; }
    if (btn) btn.disabled = true;
    let j = null; let status = 0;
    try {
      const { data: { session } = {} } = await sb.auth.getSession();
      const r = await fetch('/api/class/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session?.access_token || '') },
        body: JSON.stringify({ room: R.roomName }) });
      status = r.status; j = await r.json().catch(() => null);
    } catch (e) { status = 0; }
    if (btn) btn.disabled = false;
    if (status === 501) { toast('Students can join a quick room with a link once the video classroom is connected. Your scheduled classes are in the Calendar.', 'warn'); return; }
    if (status !== 200 || !j || !j.link) { toast((j && j.error) || 'Could not create the invitation link. Try again.', 'err'); return; }
    const msg = tr('Join my class on TeroClass:') + ' ' + j.link;
    const until = (() => { try { return new Date(j.expires_at).toLocaleTimeString(typeof uiLocale === 'function' ? uiLocale() : undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return ''; } })();
    profileModal(`<h2 id="lc-pm-h">Invite students to this room</h2>
      <p>Only people with this link can join, after signing in. It works until <b data-no-i18n>${esc(until)}</b>.</p>
      <div class="lc-share-row"><input type="text" readonly id="lc-inv-link" value="${esc(j.link)}" data-no-i18n aria-label="${esc(tr('Invitation link'))}">
        <button type="button" class="lc-btn lc-sm" data-pm="copy-link">📋 <span>Copy link</span></button></div>
      <div class="lc-share-row lc-share-apps"><a class="lc-btn lc-sm" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp</a>
        <a class="lc-btn lc-sm" href="mailto:?subject=${encodeURIComponent(tr('Live class on TeroClass'))}&body=${encodeURIComponent(msg)}">✉️ <span>Email</span></a></div>
      <div class="lc-modal-actions"><button type="button" class="lc-btn" data-pm="cancel">Close</button></div>`);
  }
  // ?room=<ad-hoc room>&t=<ticket> (a teacher's invitation link): remembered through the sign-in, then opens the lobby
  const ROOM_LINK_KEY = 'tc_room_link';
  (function rememberRoomLink() {
    try {
      const u = new URL(location.href); const room = u.searchParams.get('room'); const t = u.searchParams.get('t');
      if (!room || !t || !/^[0-9a-f]{12}-[A-Za-z0-9_-]{1,51}$/.test(room) || t.length > 1000) return;
      localStorage.setItem(ROOM_LINK_KEY, JSON.stringify({ room, t, at: Date.now() }));
      u.searchParams.delete('room'); u.searchParams.delete('t'); history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) { /* private mode: the link just doesn't survive a sign-in */ }
  })();
  function consumeRoomLink() {
    let x = null;
    try { x = JSON.parse(localStorage.getItem(ROOM_LINK_KEY) || 'null'); localStorage.removeItem(ROOM_LINK_KEY); } catch (e) { x = null; }
    if (!x || !x.room || !x.t || Date.now() - (x.at || 0) > 6 * 3600e3 || !currentUser || inViewAs()) return false;
    if (S.room) return false;
    S.planning = null; S.sessionId = null; S.sessionRole = null; S.demo = false; S.teacherName = '';
    S.adhocRoom = x.room; S.ticket = x.t; S.sessionTitle = tr('Live class');
    if (typeof showPanel === 'function') showPanel('live');
    goLobby();
    return true;
  }
  // Join a scheduled session from the calendar / student dashboard: {id, title, planning?}
  function openSession(sess) {
    if (S.room) { toast('A live class is already in progress.', 'err'); openLiveClass(); return; }
    const p = sess && sess.planning ? sess.planning : null;
    S.planning = p; S.sessionId = (sess && sess.id) || null; S.demo = false; S.adhocRoom = null; S.ticket = null;
    // role in THIS class (calendar row): a teacher enrolled in someone else's group joins as a student
    S.sessionRole = sess && (sess.role === 'teacher' || sess.role === 'student') ? sess.role : null;
    S.sessionGroup = (sess && sess.group) || '';
    S.teacherName = (sess && sess.teacher) || '';
    S.sampleKey = pickSampleKey(p || { title: [(sess && sess.title) || '', S.sessionGroup].join(' '), params: {} });
    S.sessionTitle = (sess && sess.title) || 'Live class';
    if (typeof showPanel === 'function') showPanel('live');
    goLobby();
  }
  const studentBack = () => !!(window.GC && typeof window.GC.isStudentMode === 'function' && window.GC.isStudentMode());
  function openFromDoc() {
    if (S.room) { toast('A live class is already in progress.', 'err'); openLiveClass(); return; }
    const p = planningFromDoc(); if (!p) return;
    S.sessionId = null; S.sessionRole = null; S.demo = false; S.adhocRoom = null; S.ticket = null; S.teacherName = '';
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
        S.sessionId = null; S.sessionRole = null; S.teacherName = ''; S.demo = false; S.adhocRoom = null; S.ticket = null;
        S.sampleKey = p ? pickSampleKey(p) : 'language';
        S.sessionTitle = p ? (p.title || tr('Live class')) : tr('Live class');
        goLobby(); break;
      }
      case 'try-demo': {
        // P-07: the ONLY place with invented participants, a sample plan and sample insights — labelled "Demo" everywhere
        S.planning = null; S.sessionId = null; S.sessionRole = null; S.adhocRoom = null; S.ticket = null;
        S.demo = true; S.sampleKey = 'language'; S.teacherName = '';
        S.sessionTitle = SAMPLES.language.title;
        goLobby(); break;
      }
      case 'invite-link': inviteLink(el); break;
      case 'open-cal': if (window.GC?.openSession) window.GC.openSession(el.dataset.id); else if (typeof showPanel === 'function') showPanel('calendar'); break;
      case 'open-insights': if (typeof showPanel === 'function') showPanel('insights'); break;
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
      case 'side-size': if (R) setSideWidth(sideWidth() >= SIDE_MAX - 1 ? SIDE_DEF : SIDE_MAX); break;
      case 'rec-pause': if (R) togglePause(); break;
      case 'decline-back': closeDecline(true); break;
      case 'decline-send': sendDecline(el); break;
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
      if (t.id === 'lc-decline-text') { const er = document.getElementById('lc-decline-err'); if (er) er.textContent = ''; syncDeclineUi(); return; }
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
      if (t.id === 'lc-consent') L.agree = t.checked;
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
    if (S.lobby && S.lobby.declineOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closeDecline(true); return; }
      if (e.key === 'Tab') {
        const f = ['lc-decline-text', 'lc-decline-back', 'lc-decline-send'].map(id => document.getElementById(id)).filter(x => x && !x.disabled);
        const idx = f.indexOf(document.activeElement);
        e.preventDefault(); f[(idx + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
      }
      return;
    }
    // the side panel resize handle: ← / → (wider / narrower)
    if (S.room && e.target && e.target.id === 'lc-side-grip' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); setSideWidth(sideWidth() + (e.key === 'ArrowLeft' ? 5 : -5)); return; }
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
    el.addEventListener('pointerdown', e => { onPipDown(e); onGripDown(e); });
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
    // profile: "Recording of my classes" (account menu) — status refreshed every time the menu opens
    const um = document.getElementById('user-menu');
    if (um && window.MutationObserver) new MutationObserver(() => { if (um.classList.contains('open')) refreshProfileConsent(true); }).observe(um, { attributes: true, attributeFilter: ['class'] });
    document.getElementById('um-consent')?.addEventListener('click', openConsentSettings);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // PROFILE: "Recording of my classes: On / Off" in the account menu (index.html #um-consent)
  // Off → confirmation, revoke (asked again at the next class). On → the same single checkbox (+ guardian for minors).
  // ════════════════════════════════════════════════════════════════════════════════════════
  const PM = { G: null };
  async function refreshProfileConsent(force) {
    const b = document.getElementById('um-consent'); if (!b) return;
    if (!currentUser) { b.style.display = 'none'; return; }
    b.style.display = '';
    const st = document.getElementById('um-consent-state');
    if (inViewAs()) { b.dataset.on = '0'; b.setAttribute('aria-disabled', 'true'); if (st) st.textContent = tr('Off'); return; }
    b.removeAttribute('aria-disabled');
    const d = await loadConsent(!!force);
    const on = consentOk(d);
    b.dataset.on = on ? '1' : '0';
    if (st) { st.textContent = tr(on ? 'On' : 'Off'); st.className = on ? 'um-on' : 'um-off'; }
  }
  function profileModal(html) {
    let bg = document.getElementById('lc-pmodal');
    if (!bg) {
      bg = document.createElement('div'); bg.id = 'lc-pmodal'; bg.className = 'lc-modal-bg lc-fixed lc-global'; bg.hidden = true;
      bg.addEventListener('click', onProfileClick); bg.addEventListener('change', onProfileChange); bg.addEventListener('input', onProfileChange);
      bg.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeProfileModal(); } });
      document.body.appendChild(bg);
    }
    bg.innerHTML = `<div class="lc-modal" role="dialog" aria-modal="true" aria-labelledby="lc-pm-h">${html}</div>`;
    bg.hidden = false; PM.lastFocus = document.activeElement;
    setTimeout(() => bg.querySelector('input:not([disabled]),button.lc-btn')?.focus(), 20);
  }
  function closeProfileModal() {
    const bg = document.getElementById('lc-pmodal'); if (bg) { bg.hidden = true; bg.innerHTML = ''; }
    PM.G = null; try { PM.lastFocus?.focus(); } catch (e) { /* ignore */ }
  }
  async function openConsentSettings() {
    if (typeof closeUserMenu === 'function') closeUserMenu();
    if (inViewAs()) { if (typeof vaBlocked === 'function') vaBlocked(); return; }
    const d = await loadConsent(true);
    if (consentOk(d)) {
      profileModal(`<h2 id="lc-pm-h">Turn off the recording of your classes?</h2>
        <p>From now on your classes are not recorded and you don't get new insights from them. We'll ask you again at your next class.</p>
        <div class="lc-error" id="lc-pm-err" role="alert"></div>
        <div class="lc-modal-actions"><button type="button" class="lc-btn" data-pm="cancel">Cancel</button><button type="button" class="lc-btn lc-danger" data-pm="revoke" id="lc-pm-revoke">Turn off recording</button></div>`);
    } else {
      PM.G = { agree: false, minor: false, guardian: { name: '', email: '', consent: false } };
      profileModal(`<h2 id="lc-pm-h">Recording of my classes</h2>
        <p>${esc(tr(d && d.status === 'revoked' ? 'You turned it off. Your classes are not recorded.' : 'Your classes are not recorded.'))}</p>
        <div class="lc-consents">${consentFieldsHtml(PM.G, 'lc-p-')}</div>
        <div class="lc-error" id="lc-pm-err" role="alert"></div>
        <div class="lc-modal-actions"><button type="button" class="lc-btn" data-pm="cancel">Cancel</button><button type="button" class="lc-btn lc-primary" data-pm="grant" id="lc-pm-grant">Turn on recording</button></div>`);
    }
  }
  async function onProfileClick(e) {
    if (e.target.id === 'lc-pmodal') { closeProfileModal(); return; }
    const b = e.target.closest('[data-pm]'); if (!b) return;
    const err = document.getElementById('lc-pm-err'); const setErr = m => { if (err) err.textContent = m ? tr(m) : ''; };
    if (b.dataset.pm === 'cancel') { closeProfileModal(); return; }
    if (b.dataset.pm === 'copy-link') {
      const v = document.getElementById('lc-inv-link')?.value || '';
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('✓ Copied!', 'ok'), () => { document.getElementById('lc-inv-link')?.select(); toast('Could not copy. Select the text and copy it manually (Ctrl+C / Cmd+C).', 'err'); });
      return;
    }
    if (b.dataset.pm === 'revoke') {
      b.disabled = true;
      try { await revokeConsent(); closeProfileModal(); toast("Recording turned off. We'll ask you again at your next class.", 'ok'); }
      catch (x) { setErr(dbMsg(x)); b.disabled = false; }
      refreshProfileConsent();
      return;
    }
    if (b.dataset.pm === 'grant') {
      const G = PM.G; if (!G) return;
      if (!G.agree) { setErr('Check the box to turn on recording.'); document.getElementById('lc-p-consent')?.focus(); return; }
      const ge = guardianError(G, 'lc-p-'); if (ge) { setErr(ge.msg); document.getElementById(ge.focus)?.focus(); return; }
      b.disabled = true;
      try { const d = await grantConsent(G); if (!consentOk(d)) throw new Error('Could not save your consent.'); closeProfileModal(); toast('Recording turned on ✓', 'ok'); }
      catch (x) { setErr(dbMsg(x)); b.disabled = false; }
      refreshProfileConsent();
    }
  }
  function onProfileChange(e) {
    const G = PM.G; const t = e.target; if (!G) return;
    if (t.id === 'lc-p-consent') G.agree = t.checked;
    if (t.id === 'lc-p-minor') { G.minor = t.checked; const g = document.getElementById('lc-p-guardian'); if (g) g.hidden = !G.minor; }
    if (t.id === 'lc-p-g-name') G.guardian.name = t.value;
    if (t.id === 'lc-p-g-email') G.guardian.email = t.value;
    if (t.id === 'lc-p-g-consent') G.guardian.consent = t.checked;
    const err = document.getElementById('lc-pm-err'); if (err && e.type === 'change') err.textContent = '';
  }

  // Leave any lobby/room and go back to the live-class home (used when "View as" starts or ends).
  function reset() { teardownRoom(); teardownLobby(); S.lobby = null; S.view = 'home'; }

  window.LiveClass = {
    open: openLiveClass, openFromDoc, openSession, onDocShown, reset, openConsentSettings, refreshProfileConsent, consumeRoomLink,
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
    'Teach online from TeroClass: video, your class plan beside you, and learning insights after class.': 'Da clase online desde TeroClass: video, tu planificación al lado y aprendizajes de cada estudiante después de la clase.',
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
    'raised a hand': 'levantó la mano', 'Click here to hear the class': 'Tocá acá para escuchar la clase',
    'Bigger': 'Más grande', 'Smaller': 'Más chico', 'Make the panel bigger': 'Agrandar el panel', 'Make the panel smaller': 'Achicar el panel',
    'Drag to resize the panel': 'Arrastrá para cambiar el ancho del panel',
    'Your browser is blocking the microphone. Click the lock next to the address, allow the microphone and join again.': 'El navegador está bloqueando el micrófono. Tocá el candado al lado de la dirección, permití el micrófono y volvé a entrar.',
    'Microphone on': 'Micrófono activado',
    'Could not turn on the microphone. Leave and join the class again.': 'No se pudo activar el micrófono. Salí y volvé a entrar a la clase.', 'Recording started': 'Grabación iniciada', 'participants consented': 'participantes dieron su consentimiento',
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
    // recording consent (one checkbox) + auto-recording
    'Check your camera and microphone. The first time, each person is asked once for consent to record their classes (audio only).': 'Probá tu cámara y micrófono. La primera vez, a cada persona se le pide una sola vez el consentimiento para grabar sus clases (solo audio).',
    'Classes are recorded automatically, only for people who consented. The indicator is always visible and the teacher can pause it.': 'Las clases se graban automáticamente, solo a quienes dieron su consentimiento. El indicador siempre está visible y el/la docente lo puede pausar.',
    [CONSENT_TEXT]: 'Acepto que mis clases en TeroClass se graben (solo audio) y que la IA las analice para generar mis insights y mejorar las clases.',
    'More information': 'Más información',
    [CONSENT_MORE[0]]: 'Solo se graba tu voz (audio), nunca video, y solo de quienes aceptaron.',
    [CONSENT_MORE[1]]: 'La IA genera tus insights de aprendizaje (resumen, progreso y devolución) y el informe de observación del/la docente, para mejorar las clases.',
    [CONSENT_MORE[2]]: 'El audio original se borra a los 30 días; los insights quedan en tu registro de TeroClass.',
    [CONSENT_MORE[3]]: 'Cada persona se identifica por su propio micrófono, nunca por huella de voz. Sin detección de emociones.',
    [CONSENT_MORE[4]]: 'Lo podés desactivar cuando quieras desde el menú de tu perfil (Grabación de mis clases).',
    [CONSENT_MORE[5]]: 'Menores de 18: tiene que estar de acuerdo su madre, padre o tutor/a. Lo declarás vos acá; TeroClass no lo verifica.',
    'A parent or guardian must agree for participants under 18. You declare it here: TeroClass does not verify it, and your institution sees it as "declared by the student".':
      'Para menores de 18, tiene que estar de acuerdo su madre, padre o tutor/a. Lo declarás vos acá: TeroClass no lo verifica y tu institución lo ve como "declarado por el estudiante".',
    'My parent or guardian agrees (I declare it).': 'Mi madre, padre o tutor/a está de acuerdo (lo declaro yo).',
    'Check the box to declare that your parent or guardian agrees.': 'Marcá la casilla para declarar que tu madre, padre o tutor/a está de acuerdo.',
    "Your institution already collected your family's authorization: you don't need to add your guardian's details.": 'Tu institución ya gestionó la autorización de tu familia: no hace falta que agregues los datos de tu tutor/a.',
    'Under 18: guardian consent declared by the student or managed by the institution (not verified by TeroClass)': 'Menor de 18: consentimiento del tutor/a declarado por el estudiante o gestionado por la institución (TeroClass no lo verifica)',
    'Under 18': 'Menor de 18',
    'If you write something, it goes to your institution. If you leave it empty, we only record that you said no.': 'Si escribís algo, le llega a tu institución. Si lo dejás vacío, solo queda registrado que dijiste que no.',
    'Do you want to tell us why? (optional)': '¿Querés contarnos por qué? (opcional)',
    "The guardian's email must be different from yours.": 'El email del tutor/a tiene que ser distinto del tuyo.',
    'No problem': 'Está bien', 'You can leave it empty.': 'Lo podés dejar vacío.', 'Join without recording': 'Entrar sin que me graben', 'Joining…': 'Entrando…',
    'You join as': 'Entrás como', 'Preview: nothing is recorded yet': 'Vista previa: todavía no se graba nada', 'The recorder is not connected yet: nothing is saved.': 'El grabador todavía no está conectado: no se guarda nada.',
    'Show sample participants (demo, invented names)': 'Mostrar participantes de ejemplo (demo, nombres inventados)', 'Sample plan (demo)': 'Plan de ejemplo (demo)',
    'Your next classes': 'Tus próximas clases', 'Past classes': 'Clases pasadas', 'The insights of the classes you taught are in Insights.': 'Los insights de las clases que diste están en Insights.',
    'Open Insights': 'Abrir Insights', 'Open in Calendar': 'Abrir en el Calendario', 'No classes in the next two weeks. Schedule them in the Calendar.': 'No tenés clases en las próximas dos semanas. Programalas en el Calendario.',
    'No plan attached to this class. Attach a saved class from this class in the Calendar.': 'Esta clase no tiene un plan adjunto. Adjuntá una clase guardada desde esta clase en el Calendario.',
    'Teacher (sample)': 'Docente (ejemplo)', 'Participant': 'Participante', 'Consented': 'Aceptó',
    // P-07 / TC-13 / TC-23 (2026-10)
    'The video classroom is not connected yet: a room opens in preview mode (only you, nothing is recorded).': 'El aula de video todavía no está conectada: la sala se abre en modo vista previa (solo vos, no se graba nada).',
    'For a notebook and a board, enter from a class in the Calendar.': 'Para tener cuaderno y pizarra, entrá desde una clase del Calendario.',
    'Your scheduled classes are in the Calendar. Here you can open a quick room and invite your students with a link.': 'Tus clases programadas están en el Calendario. Acá podés abrir una sala rápida e invitar a tus estudiantes con un link.',
    'No plan': 'Sin plan', 'Try the demo': 'Probar la demo', '▶ Try the demo': '▶ Probar la demo',
    'See how a class looks with a sample plan, invented participants and sample insights. Nothing is saved and nobody else sees it.': 'Mirá cómo se ve una clase con un plan de ejemplo, participantes inventados e insights de ejemplo. No se guarda nada y nadie más lo ve.',
    'Preview mode': 'Modo vista previa', 'Invite students': 'Invitar estudiantes',
    'Recording ready to be turned on — nothing is recorded yet': 'Grabación lista para activarse — todavía no se graba nada',
    'Class ended. Processing your class… (it may take a few minutes)': 'Clase terminada. Procesando tu clase… (puede tardar unos minutos)',
    'No plan for this room. Choose a saved class when you start it.': 'Esta sala no tiene plan. Elegí una clase guardada al iniciarla.',
    'Class ended. Insights are prepared for the classes scheduled in the Calendar.': 'Clase terminada. Los insights se preparan para las clases programadas en el Calendario.', 'You left the class.': 'Saliste de la clase.',
    'Students can join a quick room with a link once the video classroom is connected. Your scheduled classes are in the Calendar.': 'Los estudiantes van a poder entrar a una sala rápida con un link cuando se conecte el aula de video. Tus clases programadas están en el Calendario.',
    'Could not create the invitation link. Try again.': 'No se pudo crear el link de invitación. Probá de nuevo.', 'Join my class on TeroClass:': 'Entrá a mi clase en TeroClass:',
    'Invite students to this room': 'Invitar estudiantes a esta sala', 'Only people with this link can join, after signing in. It works until': 'Solo pueden entrar las personas que tengan este link, después de iniciar sesión. Funciona hasta las',
    'Invitation link': 'Link de invitación', 'Copy link': 'Copiar link', 'Email': 'Email', 'Live class on TeroClass': 'Clase en vivo en TeroClass',
    '✓ Copied!': '✓ ¡Copiado!', 'Could not copy. Select the text and copy it manually (Ctrl+C / Cmd+C).': 'No se pudo copiar. Seleccioná el texto y copialo a mano (Ctrl+C / Cmd+C).',
    'A parent or guardian must agree for participants under 18.': 'Para menores de 18, tiene que aceptar su madre, padre o tutor/a.',
    'I am the parent or guardian and I agree to the above.': 'Soy la madre, el padre o tutor/a y acepto lo de arriba.',
    "We ask only once. If you don't agree, you can still join the class without being recorded.": 'Te lo preguntamos una sola vez. Si no aceptás, podés entrar igual a la clase sin que te graben.',
    'Checking your recording consent…': 'Revisando tu consentimiento de grabación…',
    "You already agreed: your classes are recorded (audio only). We won't ask you again.": 'Ya aceptaste: tus clases se graban (solo audio). No te lo vamos a volver a preguntar.',
    'You can turn it off at any time from your profile menu (Recording of my classes).': 'Lo podés desactivar cuando quieras desde el menú de tu perfil (Grabación de mis clases).',
    'View as is read-only: nothing is saved and you join without being recorded.': '"Ver como" es de solo lectura: no se guarda nada y entrás sin ser grabado/a.',
    '● You will be recorded (audio only)': '● Te vamos a grabar (solo audio)',
    'No emotion detection. Speakers are identified by their own microphone, never by voiceprint. You can turn recording off at any time from your profile menu.': 'Sin detección de emociones. Cada persona se identifica por su propio micrófono, nunca por huella de voz. Podés desactivar la grabación cuando quieras desde el menú de tu perfil.',
    'Explain your answer': 'Justificá tu respuesta',
    "Tell us why you don't want your classes to be recorded. Your answer goes to your institution.": 'Contanos por qué no querés que se graben tus clases. Tu respuesta le llega a la institución.',
    'You can still join the class without being recorded.': 'Podés entrar igual a la clase sin que te graben.',
    'Your reason (required)': 'Tu motivo (obligatorio)', 'At least 10 characters.': 'Mínimo 10 caracteres.', '← Back': '← Volver',
    'Send and join without recording': 'Enviar y entrar sin grabar', 'Sending…': 'Enviando…',
    'Please write at least 10 characters.': 'Escribí al menos 10 caracteres.',
    'Your answer could not be saved. You join without being recorded.': 'No se pudo guardar tu respuesta. Entrás sin que te graben.',
    'Could not save your consent.': 'No se pudo guardar tu consentimiento.',
    'Recording — only people who gave consent': 'Grabando — solo quienes dieron su consentimiento',
    'Recording paused — resumes automatically': 'Grabación en pausa — se reanuda sola',
    'You: not recorded': 'A vos no te graban', 'Pause recording': 'Pausar grabación',
    'Recording paused. It resumes automatically in 5 minutes.': 'Grabación en pausa. Se reanuda sola en 5 minutos.',
    'Recording resumed automatically': 'La grabación se reanudó sola',
    'The teacher paused the recording. It resumes automatically.': 'El/la docente pausó la grabación. Se reanuda sola.',
    'The call ends for all participants and the recording stops. Insights are prepared next.': 'La llamada termina para todos y se detiene la grabación. A continuación se preparan los insights.',
    // profile
    'Recording of my classes': 'Grabación de mis clases', 'Recording of my classes:': 'Grabación de mis clases:', 'On': 'Activada', 'Off': 'Desactivada',
    'Turn off the recording of your classes?': '¿Desactivar la grabación de tus clases?',
    "From now on your classes are not recorded and you don't get new insights from them. We'll ask you again at your next class.": 'Desde ahora tus clases no se graban y no vas a recibir insights nuevos de ellas. Te lo vamos a volver a preguntar en tu próxima clase.',
    'Turn off recording': 'Desactivar grabación', 'Turn on recording': 'Activar grabación',
    'You turned it off. Your classes are not recorded.': 'La desactivaste. Tus clases no se graban.', 'Your classes are not recorded.': 'Tus clases no se graban.',
    "Recording turned off. We'll ask you again at your next class.": 'Grabación desactivada. Te lo vamos a volver a preguntar en tu próxima clase.',
    'Recording consent': 'Consentimiento de grabación',
    'Recording turned on ✓': 'Grabación activada ✓', 'Check the box to turn on recording.': 'Marcá la casilla para activar la grabación.',
  });
  if (typeof DB_ERRORS !== 'undefined') DB_ERRORS.unshift(
    [/Menores de 18: el email del tutor\/a tiene que ser distinto del tuyo/, "The guardian's email must be different from yours."],
    [/Ya diste tu consentimiento/, 'You already agreed to the recording.'],
    [/El texto del consentimiento cambió: recargá la página/, 'The consent text changed: please reload the page.'],
    [/Menores de 18: falta el nombre del tutor\/a/, "Please write the guardian's name."],
    [/Menores de 18: email del tutor\/a inválido/, 'Please write a valid guardian email.'],
    [/Menores de 18: el tutor\/a tiene que confirmar el consentimiento/, 'The guardian must confirm the consent.'],
    [/Demasiadas respuestas hoy: probá mañana/, 'Too many answers today: try again tomorrow.']
  );
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    'You already agreed to the recording.': 'Ya aceptaste la grabación.', 'The consent text changed: please reload the page.': 'El texto del consentimiento cambió: recargá la página.',
    'Too many answers today: try again tomorrow.': 'Demasiadas respuestas por hoy: probá mañana.',
  });

  init();
  // The app may already have translated the page before this file loaded.
  try { if (typeof uiLang !== 'undefined' && uiLang === 'es' && typeof translateTree === 'function') { i18nBusy = true; try { translateTree(document.body); } finally { i18nBusy = false; } } } catch (e) { /* ignore */ }
})();
