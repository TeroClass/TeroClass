/* TeroClass · CSV import parser (groups, students and their weekly schedule)
 * ------------------------------------------------------------------------------------------
 * Build-free and dependency-free: loaded by index.html before groups-calendar.js (window.TCImport) and
 * required by the node unit tests (tests/unit-csv-import.test.mjs).
 *  · Flexible headers: Spanish or English, any case, accents ignored ("Días", "hora_inicio", "teacher_email"…).
 *  · Flexible days: "Lun;Mié", "L,Mi", "lunes y miércoles", "Mon/Wed", "LMi", "lun a vie". "M" / "T" alone are
 *    ambiguous (martes / miércoles / Monday; Tuesday / Thursday) → error.
 *  · Flexible times (07:00, 7:00, 7am, 19:30, 19h30, "7:00-8:00") and dates (YYYY-MM-DD, DD/MM/YYYY, DD/MM;
 *    day/month first, as in Uruguay). Anything ambiguous or invalid is reported per row; the database re-validates.
 * Returns normalized values (weekdays 1 = Monday … 7 = Sunday, "HH:MM", minutes, "YYYY-MM-DD", IANA time zone).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCImport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_ROWS = 2000;
  const MAX_RANGE_DAYS = 366; // a series lasts up to one year (same rule as the database)
  const strip = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normHeader = h => strip(h).toLowerCase().replace(/[\s_\-.()/:]/g, '');
  const pad = n => String(n).padStart(2, '0');

  // ── headers ──────────────────────────────────────────────────────────────────────────────
  const HEADER_ALIASES = {
    email: ['email', 'mail', 'correo', 'correoelectronico', 'emailalumno', 'emailestudiante', 'studentemail', 'emaildelalumno', 'emaildelestudiante', 'correoalumno', 'correoestudiante'],
    name: ['name', 'nombre', 'fullname', 'nombrecompleto', 'student', 'alumno', 'alumna', 'estudiante', 'studentname', 'nombreyapellido', 'nombreapellido'],
    group: ['group', 'grupo', 'clase', 'class', 'course', 'curso', 'groupname', 'nombregrupo', 'nombredelgrupo'],
    teacher_email: ['teacheremail', 'teacher', 'docente', 'docenteemail', 'emaildocente', 'correodocente', 'profesor', 'profesora', 'profesoremail', 'emailprofesor', 'maestro', 'maestra'],
    unit: ['unit', 'unidad', 'slug', 'sede', 'catedra', 'area', 'unitslug'],
    substitute_email: ['substituteemail', 'substitute', 'suplente', 'suplenteemail', 'emailsuplente', 'correosuplente', 'docentesuplente', 'reemplazo', 'subteacher'],
    days: ['days', 'dias', 'dia', 'day', 'weekdays', 'diasdelasemana', 'diasdeclase'],
    start_time: ['starttime', 'start', 'hora', 'horainicio', 'horadeinicio', 'horario', 'time', 'horaentrada', 'desdehora', 'begintime'],
    end_time: ['endtime', 'end', 'horafin', 'horadefin', 'horafinal', 'horasalida', 'hastahora', 'finishtime'],
    duration_min: ['duration', 'durationmin', 'durationminutes', 'duracion', 'duracionmin', 'duracionminutos', 'minutos', 'minutes', 'mins'],
    start_date: ['startdate', 'desde', 'inicio', 'fechainicio', 'fechadeinicio', 'from', 'comienzo', 'fechadesde'],
    end_date: ['enddate', 'hasta', 'fin', 'fechafin', 'fechadefin', 'until', 'to', 'termina', 'finaliza', 'fechahasta', 'fechafinal'],
    timezone: ['timezone', 'zona', 'zonahoraria', 'tz', 'huso', 'husohorario'],
  };
  const ALIAS_INDEX = (() => { const m = {}; for (const [k, al] of Object.entries(HEADER_ALIASES)) for (const a of al) m[a] = k; return m; })();
  const headerKey = h => ALIAS_INDEX[normHeader(h)] || null;

  // ── CSV (comma, semicolon or tab; quotes) ────────────────────────────────────────────────
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    const first = (text.split(/\r?\n/).find(l => l.trim()) || '');
    const count = ch => { let n = 0; let q = false; for (const c of first) { if (c === '"') q = !q; else if (!q && c === ch) n++; } return n; };
    const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  // ── days ─────────────────────────────────────────────────────────────────────────────────
  const DAY_WORDS = {
    lunes: 1, lun: 1, lu: 1, l: 1, monday: 1, mon: 1, mo: 1,
    martes: 2, mar: 2, ma: 2, tuesday: 2, tue: 2, tues: 2, tu: 2,
    miercoles: 3, mie: 3, mier: 3, mi: 3, x: 3, wednesday: 3, wed: 3, we: 3, w: 3,
    jueves: 4, jue: 4, ju: 4, j: 4, thursday: 4, thu: 4, thur: 4, thurs: 4, th: 4,
    viernes: 5, vie: 5, vi: 5, v: 5, friday: 5, fri: 5, fr: 5, f: 5,
    sabado: 6, sab: 6, sa: 6, s: 6, saturday: 6, sat: 6,
    domingo: 7, dom: 7, do: 7, d: 7, sunday: 7, sun: 7, su: 7,
  };
  const AMBIGUOUS_DAYS = new Set(['m', 't']);
  // compact codes for "LMi", "MaJ", "lmiv" (longest first)
  const CODES = ['mie', 'mi', 'ma', 'lu', 'ju', 'vi', 'sa', 'do', 'x', 'l', 'j', 'v', 's', 'd'];
  function segment(tok) { // → {days} | {error}
    // Capitalized compact forms: "LMi" → L + Mi, "MaJ" → Ma + J
    if (/[A-Z]/.test(tok.slice(1)) && /[a-z]/.test(tok) && /^[A-Za-z]+$/.test(tok)) {
      const parts = tok.match(/[A-Z][a-z]*/g) || [];
      if (parts.join('') === tok) {
        const out = [];
        for (const p of parts) {
          const k = p.toLowerCase();
          if (AMBIGUOUS_DAYS.has(k)) return { error: 'ambiguous_day' };
          if (!DAY_WORDS[k]) return { error: 'bad_days' };
          out.push(DAY_WORDS[k]);
        }
        return { days: out };
      }
    }
    let s = tok.toLowerCase(); const out = []; let amb = false;
    if (!/^[a-z]{2,8}$/.test(s)) return { error: 'bad_days' };
    while (s) {
      const c = CODES.find(x => s.startsWith(x));
      if (c) { out.push(DAY_WORDS[c]); s = s.slice(c.length); continue; }
      if (s[0] === 'm') { amb = true; s = s.slice(1); continue; }
      return { error: 'bad_days' };
    }
    return amb ? { error: 'ambiguous_day' } : { days: out };
  }
  function dayToken(tok) {
    const k = tok.toLowerCase();
    if (AMBIGUOUS_DAYS.has(k)) return { error: 'ambiguous_day' };
    if (DAY_WORDS[k]) return { days: [DAY_WORDS[k]] };
    return segment(tok);
  }
  // → { days: [1..7] } | { empty: true } | { error: 'ambiguous_day' | 'bad_days' }
  function parseDays(input) {
    let s = strip(input).replace(/\./g, ' ').trim();
    if (!s) return { empty: true, days: [] };
    s = s.replace(/\s*(?:-|–|—)\s*/g, '~').replace(/\s+(?:a|al|to|hasta|until|through)\s+/gi, '~');
    s = s.replace(/(^|\s)(?:y|and|e)(?=\s|$)/gi, ' ');
    const pieces = s.split(/[;,/&+|\s]+/).filter(Boolean);
    if (!pieces.length) return { error: 'bad_days' };
    const set = new Set(); let err = null;
    for (const p of pieces) {
      if (p.includes('~')) { // range: "lun~vie", "Mon~Fri"
        const ends = p.split('~').filter(Boolean);
        if (ends.length !== 2) { err = err || 'bad_days'; continue; }
        const a = dayToken(ends[0]); const b = dayToken(ends[1]);
        if (a.error || b.error) { err = err === 'ambiguous_day' ? err : (a.error === 'ambiguous_day' || b.error === 'ambiguous_day' ? 'ambiguous_day' : 'bad_days'); continue; }
        if (a.days.length !== 1 || b.days.length !== 1) { err = err || 'bad_days'; continue; }
        for (let d = a.days[0], n = 0; n < 7; d = d % 7 + 1, n++) { set.add(d); if (d === b.days[0]) break; }
        continue;
      }
      const r = dayToken(p);
      if (r.error) { if (r.error === 'ambiguous_day' || !err) err = r.error; continue; }
      r.days.forEach(d => set.add(d));
    }
    if (err) return { error: err };
    return { days: [...set].sort((a, b) => a - b) };
  }

  // ── times ────────────────────────────────────────────────────────────────────────────────
  // → { hm: "HH:MM", min } | { empty } | { error: 'bad_time' }
  function parseTime(input) {
    let s = strip(input).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!s) return { empty: true };
    s = s.replace(/a\.?\s?m\.?$/, 'am').replace(/p\.?\s?m\.?$/, 'pm');
    const m = /^(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?\s*(?:hs|hrs|h)?\.?\s*(am|pm)?$/.exec(s);
    if (!m) return { error: 'bad_time' };
    let h = +m[1]; const mi = m[2] == null ? 0 : +m[2];
    if (mi > 59) return { error: 'bad_time' };
    if (m[3]) { if (h < 1 || h > 12) return { error: 'bad_time' }; if (m[3] === 'am') h = h === 12 ? 0 : h; else h = h === 12 ? 12 : h + 12; }
    else if (h > 23) return { error: 'bad_time' };
    return { hm: `${pad(h)}:${pad(mi)}`, min: h * 60 + mi };
  }
  // "07:00-08:00", "7 a 8", "19:30–21" → { start, end } | null (not a range)
  function parseTimeRange(input) {
    const s = strip(input).trim();
    const m = /^(.+?)(?:\s*(?:-|–|—)\s*|\s+(?:a|to|hasta)\s+)(.+)$/i.exec(s);
    if (!m) return null;
    const a = parseTime(m[1]); const b = parseTime(m[2]);
    if (a.error || b.error || a.empty || b.empty) return null;
    return { start: a, end: b };
  }
  // "60", "60 min", "90'", "1h", "1 h 30", "1:30", "1,5 h" → { min } | { empty } | { error: 'bad_duration' }
  function parseDuration(input) {
    const s = strip(input).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!s) return { empty: true };
    let min = null; let m;
    if ((m = /^(\d{1,3})\s*(?:m|min|mins|minutos|minutes|')?$/.exec(s))) min = +m[1];
    else if ((m = /^(\d{1,2})\s*(?:h|hs|hr|hrs|horas|hora|hours|hour)\s*(?:(\d{1,2})\s*(?:m|min|mins|minutos)?)?$/.exec(s))) min = +m[1] * 60 + (m[2] ? +m[2] : 0);
    else if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) min = +m[1] * 60 + +m[2];
    else if ((m = /^(\d{1,2})[.,](\d{1,2})\s*(?:h|hs|hr|hrs|horas|hours)$/.exec(s))) min = Math.round(parseFloat(m[1] + '.' + m[2]) * 60);
    if (min == null || min < 5 || min > 720) return { error: 'bad_duration' };
    return { min };
  }

  // ── dates (day/month first) ──────────────────────────────────────────────────────────────
  const validYmd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
  const ymdStr = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  // → { ymd, noYear } | { empty } | { error: 'bad_date' | 'date_mdy' }
  function parseDate(input, refYear) {
    const s = strip(input).trim();
    if (!s) return { empty: true };
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
    if (m) { const y = +m[1], mo = +m[2], d = +m[3]; return validYmd(y, mo, d) ? { ymd: ymdStr(y, mo, d) } : { error: 'bad_date' }; }
    m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?$/.exec(s);
    if (!m) return { error: 'bad_date' };
    const a = +m[1], b = +m[2];
    const noYear = m[3] == null;
    const y = noYear ? (refYear || new Date().getFullYear()) : (m[3].length === 2 ? 2000 + +m[3] : +m[3]);
    if (b > 12 && a >= 1 && a <= 12 && validYmd(y, a, b)) return { error: 'date_mdy' }; // 04/25/2027: month/day
    if (!validYmd(y, b, a)) return { error: 'bad_date' };
    return { ymd: ymdStr(y, b, a), noYear };
  }
  const daysBetween = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5;
  const addYear = ymd => { const [y, m, d] = ymd.split('-').map(Number); return validYmd(y + 1, m, d) ? ymdStr(y + 1, m, d) : ymdStr(y + 1, m, d - 1); };

  // ── time zones ───────────────────────────────────────────────────────────────────────────
  const TZ_ALIASES = {
    montevideo: 'America/Montevideo', uruguay: 'America/Montevideo', uy: 'America/Montevideo', uyt: 'America/Montevideo',
    buenosaires: 'America/Argentina/Buenos_Aires', argentina: 'America/Argentina/Buenos_Aires', ar: 'America/Argentina/Buenos_Aires',
    madrid: 'Europe/Madrid', espana: 'Europe/Madrid', spain: 'Europe/Madrid', es: 'Europe/Madrid',
    santiago: 'America/Santiago', chile: 'America/Santiago', saopaulo: 'America/Sao_Paulo', brasil: 'America/Sao_Paulo', brazil: 'America/Sao_Paulo',
    asuncion: 'America/Asuncion', paraguay: 'America/Asuncion', lima: 'America/Lima', peru: 'America/Lima', bogota: 'America/Bogota', colombia: 'America/Bogota',
    mexico: 'America/Mexico_City', cdmx: 'America/Mexico_City', utc: 'UTC', gmt: 'UTC',
  };
  function parseTz(input) {
    const s = String(input ?? '').trim();
    if (!s) return { empty: true };
    const a = TZ_ALIASES[normHeader(s)]; if (a) return { tz: a };
    try { const tz = new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone; if (tz && /\//.test(s)) return { tz }; } catch (e) { /* invalid */ }
    return { error: 'bad_tz' };
  }

  const EMAIL_RE = /^[^\s@<>"',;()]{1,64}@[^\s@<>"',;()]{1,190}\.[A-Za-z]{2,24}$/;

  // ── rows ─────────────────────────────────────────────────────────────────────────────────
  // One CSV record → normalized row for the database (import_students) + per-row errors / warnings.
  function buildRow(get, line, refYear) {
    const errors = []; const warnings = [];
    const add = c => { if (!errors.includes(c)) errors.push(c); };
    const row = { line, email: get('email'), name: get('name'), group: get('group'), teacher_email: get('teacher_email'), unit: get('unit'),
      substitute_email: get('substitute_email'), weekdays: null, start_time: null, duration_min: null, start_date: null, end_date: null, timezone: null };
    const raw = { days: get('days'), start_time: get('start_time'), end_time: get('end_time'), duration_min: get('duration_min'), start_date: get('start_date'), end_date: get('end_date'), timezone: get('timezone') };
    if (row.teacher_email && !EMAIL_RE.test(row.teacher_email)) add('bad_teacher_email');
    if (row.substitute_email && !EMAIL_RE.test(row.substitute_email)) add('bad_substitute_email');
    if (row.teacher_email && row.substitute_email && row.teacher_email.toLowerCase() === row.substitute_email.toLowerCase()) add('same_person');
    const d = parseDays(raw.days);
    if (d.error) add(d.error); else if (!d.empty) row.weekdays = d.days;
    let start = null; let end = null;
    const range = raw.start_time && !raw.end_time ? parseTimeRange(raw.start_time) : null;
    if (range) { start = range.start; end = range.end; }
    else {
      const a = parseTime(raw.start_time); if (a.error) add('bad_time'); else if (!a.empty) start = a;
      const b = parseTime(raw.end_time); if (b.error) add('bad_end_time'); else if (!b.empty) end = b;
    }
    const dur = parseDuration(raw.duration_min);
    if (dur.error) add('bad_duration');
    if (start) row.start_time = start.hm;
    if (start && end) {
      const m = end.min - start.min;
      if (m < 5 || m > 720) add('bad_end_time');
      else if (!dur.empty && !dur.error && dur.min !== m) add('time_conflict');
      else row.duration_min = m;
    } else if (end && !start) add('bad_time');
    else if (!dur.empty && !dur.error) row.duration_min = dur.min;
    const sd = parseDate(raw.start_date, refYear); const ed = parseDate(raw.end_date, refYear);
    if (sd.error) add(sd.error === 'date_mdy' ? 'date_mdy' : 'bad_date'); else if (!sd.empty) row.start_date = sd.ymd;
    if (ed.error) add(ed.error === 'date_mdy' ? 'date_mdy' : 'bad_end_date'); else if (!ed.empty) row.end_date = ed.ymd;
    if (row.start_date && row.end_date) {
      if (row.end_date < row.start_date && sd.noYear && ed.noYear) row.end_date = addYear(row.end_date); // "del 1/9 al 30/6"
      if (row.end_date < row.start_date) add('end_before_start');
      else if (daysBetween(row.start_date, row.end_date) > MAX_RANGE_DAYS) add('range_too_long');
    }
    if ((sd.noYear && !sd.empty) || (ed.noYear && !ed.empty)) warnings.push('date_no_year');
    const tz = parseTz(raw.timezone);
    if (tz.error) add('bad_tz'); else if (!tz.empty) row.timezone = tz.tz;
    if (errors.length) row.errors = errors;
    if (warnings.length) row.warnings = warnings;
    row.raw = raw;
    return row;
  }

  // text → { rows, cols, ignored } | { error }
  function csvToRows(text, opts = {}) {
    const all = parseCsv(text);
    const head = all.findIndex(r => r.some(c => c.trim()));
    if (head < 0) return { error: 'The file has no rows.' };
    const cols = {}; const ignored = [];
    all[head].forEach((h, i) => { const k = headerKey(h); if (k && cols[k] == null) cols[k] = i; else if (String(h).trim()) ignored.push(String(h).trim()); });
    if (cols.email == null && cols.group == null) return { error: 'The file needs an "email" or a "group" column (header in the first row).' };
    const refYear = opts.refYear || new Date().getFullYear();
    const rows = [];
    for (let i = head + 1; i < all.length; i++) {
      const r = all[i]; if (!r.some(c => c.trim())) continue;
      const get = k => (cols[k] == null ? '' : String(r[cols[k]] ?? '').trim());
      rows.push(buildRow(get, i + 1, refYear));
    }
    if (!rows.length) return { error: 'The file has no rows.' };
    if (rows.length > MAX_ROWS) return { error: 'Too many rows: the limit is 2,000.' };
    return { rows, cols: Object.keys(cols), ignored };
  }
  // what is sent to the database (no raw strings)
  const toRpcRows = rows => rows.map(r => { const o = { ...r }; delete o.raw; return o; });

  // ── human words ──────────────────────────────────────────────────────────────────────────
  const DAY_ABBR = { es: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'], en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
  const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function joinList(items, lang) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + (lang === 'es' ? ' y ' : ' & ') + items[items.length - 1];
  }
  const hmPlus = (hm, min) => { const [h, m] = String(hm).split(':').map(Number); const t = (h * 60 + m + min) % 1440; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
  function shortDate(ymd, lang, thisYear) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    if (lang === 'es') return y === thisYear ? `${d}/${m}` : `${d}/${m}/${y}`;
    return `${MONTHS_EN[m - 1]} ${d}${y === thisYear ? '' : ', ' + y}`;
  }
  // { weekdays, start_time, duration_min, start_date, end_date } → "Lun y Mié 07:00–08:00, del 3/3 al 30/11"
  function humanSchedule(s, lang = 'es', thisYear = new Date().getFullYear()) {
    if (!s) return '';
    const L = lang === 'es' ? 'es' : 'en';
    const parts = [];
    if (s.weekdays && s.weekdays.length) parts.push(joinList(s.weekdays.map(d => DAY_ABBR[L][d - 1]), L));
    if (s.start_time) parts.push(s.duration_min ? `${s.start_time}–${hmPlus(s.start_time, s.duration_min)}` : s.start_time);
    let txt = parts.join(' ');
    if (s.start_date && s.end_date) txt += L === 'es' ? `, del ${shortDate(s.start_date, L, thisYear)} al ${shortDate(s.end_date, L, thisYear)}` : `, ${shortDate(s.start_date, L, thisYear)} – ${shortDate(s.end_date, L, thisYear)}`;
    else if (s.end_date) txt += L === 'es' ? `, hasta el ${shortDate(s.end_date, L, thisYear)}` : `, until ${shortDate(s.end_date, L, thisYear)}`;
    return txt;
  }

  // ── template ─────────────────────────────────────────────────────────────────────────────
  const TEMPLATE_HEADERS = {
    en: ['email', 'name', 'group', 'teacher_email', 'unit', 'substitute_email', 'days', 'start_time', 'end_time', 'start_date', 'end_date', 'timezone'],
    es: ['email', 'nombre', 'grupo', 'docente', 'unidad', 'suplente', 'dias', 'hora_inicio', 'hora_fin', 'desde', 'hasta', 'zona'],
  };
  // 3 realistic example groups (dates relative to today so the template always imports)
  function templateCsv(lang = 'es', today = new Date()) {
    const L = lang === 'es' ? 'es' : 'en';
    const dmy = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
    const until = new Date(from.getFullYear(), from.getMonth() + 8, from.getDate());
    const q = v => (/[",;\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const rows = [
      ['', '', 'INEFOP A1.1 LMi 7:00', 'docente@instituto.edu.uy', '', 'suplente@instituto.edu.uy', 'Lun;Mié', '07:00', '08:00', dmy(from), dmy(until), 'America/Montevideo'],
      ['ana.perez@correo.com', 'Ana Pérez', 'INEFOP A1.1 LMi 7:00', '', '', '', '', '', '', '', '', ''],
      ['bruno.diaz@correo.com', 'Bruno Díaz', 'INEFOP A1.1 LMi 7:00', '', '', '', '', '', '', '', '', ''],
      ['carla.ruiz@correo.com', 'Carla Ruiz', 'Inglés B1 MaJ 19:30', 'docente2@instituto.edu.uy', '', '', 'Mar y Jue', '19:30', '21:00', dmy(from), dmy(until), 'America/Montevideo'],
      ['diego.sosa@correo.com', 'Diego Sosa', 'Portugués A2 Sáb', 'docente@instituto.edu.uy', '', '', 'Sábado', '10:00', '12:00', dmy(from), dmy(until), ''],
    ];
    return '﻿' + [TEMPLATE_HEADERS[L], ...rows].map(r => r.map(q).join(',')).join('\n') + '\n';
  }

  return { MAX_ROWS, MAX_RANGE_DAYS, HEADER_ALIASES, TEMPLATE_HEADERS, DAY_ABBR, EMAIL_RE, normHeader, headerKey, parseCsv, parseDays, parseTime,
    parseTimeRange, parseDuration, parseDate, parseTz, buildRow, csvToRows, toRpcRows, humanSchedule, hmPlus, templateCsv };
});
