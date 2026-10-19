// Unit tests for the CSV import parser (public/csv-import.js): headers, days, times, durations, dates, time zones,
// whole rows, human schedule text, template. Run: node --no-warnings --test tests/unit-csv-import.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../public/csv-import.js');

test('headers: Spanish / English, any case, accents and separators ignored', () => {
  const cases = { 'Docente': 'teacher_email', 'teacher_email': 'teacher_email', 'SUPLENTE': 'substitute_email', 'Substitute': 'substitute_email',
    'Días': 'days', 'dias': 'days', 'Days': 'days', 'Hora': 'start_time', 'hora_inicio': 'start_time', 'Start Time': 'start_time',
    'Hora fin': 'end_time', 'end_time': 'end_time', 'Duración': 'duration_min', 'duration': 'duration_min', 'Desde': 'start_date', 'inicio': 'start_date',
    'start_date': 'start_date', 'Hasta': 'end_date', 'FIN': 'end_date', 'end_date': 'end_date', 'Zona': 'timezone', 'Time zone': 'timezone',
    'Grupo': 'group', 'Unidad': 'unit', 'Nombre': 'name', 'E-mail': 'email', 'Correo electrónico': 'email' };
  for (const [h, k] of Object.entries(cases)) assert.equal(T.headerKey(h), k, h);
  assert.equal(T.headerKey('Observaciones'), null);
});

test('days: flexible forms (ES/EN, separators, compact, ranges)', () => {
  const ok = { 'Lun;Mié': [1, 3], 'L,Mi': [1, 3], 'lunes y miércoles': [1, 3], 'Mon/Wed': [1, 3], 'LMi': [1, 3], 'LMI': [1, 3], 'lmi': [1, 3],
    'MaJ': [2, 4], 'Mar y Jue': [2, 4], 'Tue and Thu': [2, 4], 'martes jueves': [2, 4], 'LuMiVi': [1, 3, 5], 'Lun. Mié. Vie.': [1, 3, 5],
    'lunes a viernes': [1, 2, 3, 4, 5], 'Mon-Fri': [1, 2, 3, 4, 5], 'Sábado': [6], 'domingo': [7], 'Saturday, Sunday': [6, 7], 'Mi': [3], 'Ma': [2], 'X': [3],
    'MONDAY; WEDNESDAY': [1, 3], 'mie': [3], 'Thurs': [4] };
  for (const [s, d] of Object.entries(ok)) assert.deepEqual(T.parseDays(s).days, d, s);
  for (const s of ['M', 'Lun;M', 'LM', 'T', 'Tu;T']) assert.equal(T.parseDays(s).error, 'ambiguous_day', s);
  for (const s of ['xyz', 'Lunesday', '1;3']) assert.equal(T.parseDays(s).error, 'bad_days', s);
  assert.equal(T.parseDays('  ').empty, true);
});

test('times: 07:00, 7:00, 7am, 19:30, 19h30, 7 pm; invalid flagged', () => {
  const ok = { '07:00': '07:00', '7:00': '07:00', '7am': '07:00', '7 a.m.': '07:00', '19:30': '19:30', '19h30': '19:30', '7 pm': '19:00', '12pm': '12:00', '12am': '00:00', '7.30 hs': '07:30', '8': '08:00' };
  for (const [s, hm] of Object.entries(ok)) assert.equal(T.parseTime(s).hm, hm, s);
  for (const s of ['25:00', '7:60', '13pm', 'siete', '7:5']) assert.equal(T.parseTime(s).error, 'bad_time', s);
  assert.deepEqual(T.parseTimeRange('07:00-08:00'), { start: { hm: '07:00', min: 420 }, end: { hm: '08:00', min: 480 } });
  assert.equal(T.parseTimeRange('19:30 a 21').end.hm, '21:00');
  assert.equal(T.parseTimeRange('07:00'), null);
});

test('durations: minutes, hours, h:mm; 5 to 720 minutes', () => {
  const ok = { '60': 60, '90 min': 90, "90'": 90, '1h': 60, '1 h 30': 90, '1:30': 90, '1,5 h': 90, '2 horas': 120 };
  for (const [s, m] of Object.entries(ok)) assert.equal(T.parseDuration(s).min, m, s);
  for (const s of ['3', '800', 'una hora']) assert.equal(T.parseDuration(s).error, 'bad_duration', s);
});

test('dates: YYYY-MM-DD and DD/MM/YYYY (day first, Uruguay); ambiguous / invalid flagged', () => {
  assert.equal(T.parseDate('2027-03-02').ymd, '2027-03-02');
  assert.equal(T.parseDate('3/3/2027').ymd, '2027-03-03');
  assert.equal(T.parseDate('02/03/2027').ymd, '2027-03-02'); // day/month by default
  assert.equal(T.parseDate('1-9-27').ymd, '2027-09-01');
  assert.equal(T.parseDate('30.11.2027').ymd, '2027-11-30');
  assert.deepEqual(T.parseDate('30/11', 2026), { ymd: '2026-11-30', noYear: true });
  assert.equal(T.parseDate('04/25/2027').error, 'date_mdy'); // looks like month/day
  for (const s of ['31/02/2027', '2027-13-01', '32/01/2027', 'mañana', '3 de marzo']) assert.equal(T.parseDate(s).error, 'bad_date', s);
});

test('time zones: IANA names and common aliases', () => {
  assert.equal(T.parseTz('America/Montevideo').tz, 'America/Montevideo');
  assert.equal(T.parseTz('america/montevideo').tz, 'America/Montevideo');
  assert.equal(T.parseTz('Montevideo').tz, 'America/Montevideo');
  assert.equal(T.parseTz('España').tz, 'Europe/Madrid');
  assert.equal(T.parseTz('Mars/Olympus').error, 'bad_tz');
});

test('rows: normalized schedule, end time → duration, per-row errors', () => {
  const csv = ['email,nombre,grupo,docente,suplente,días,hora_inicio,hora_fin,desde,hasta,zona',
    ',,INEFOP A1.1,doc@x.uy,sup@x.uy,"Lun;Mié",7:00,8:00,3/3/2027,30/11/2027,Montevideo',
    'ana@x.uy,Ana,INEFOP A1.1,,,,,,,,',
    'bob@x.uy,Bob,Inglés,,,M,19:30,21:00,,,',
    'cid@x.uy,Cid,Inglés,,,Mar,19:30,19:00,31/02/2027,,',
    'dee@x.uy,Dee,Largo,,,Lun,10:00,11:00,1/1/2027,1/6/2028,',
    'eve@x.uy,Eve,Mal,a@x.uy,A@x.uy,Lun,07:00-08:30,,1/9,30/6,Marte'].join('\n');
  const r = T.csvToRows(csv, { refYear: 2026 });
  assert.deepEqual(r.cols.sort(), ['days', 'email', 'end_date', 'end_time', 'group', 'name', 'start_date', 'start_time', 'substitute_email', 'teacher_email', 'timezone'].sort());
  const [a, b, c, d, e, f] = r.rows;
  assert.deepEqual({ ...a, raw: undefined }, { line: 2, email: '', name: '', group: 'INEFOP A1.1', teacher_email: 'doc@x.uy', unit: '', substitute_email: 'sup@x.uy',
    weekdays: [1, 3], start_time: '07:00', duration_min: 60, start_date: '2027-03-03', end_date: '2027-11-30', timezone: 'America/Montevideo', raw: undefined });
  assert.equal(b.errors, undefined);
  assert.deepEqual(c.errors, ['ambiguous_day']);
  assert.deepEqual(d.errors, ['bad_end_time', 'bad_date']);
  assert.deepEqual(e.errors, ['range_too_long']);
  assert.deepEqual(f.errors, ['same_person', 'bad_tz']);
  assert.equal(f.duration_min, 90);                                  // "07:00-08:30" in the start column
  assert.equal(f.end_date, '2027-06-30');                            // "del 1/9 al 30/6" → next year
  assert.deepEqual(f.warnings, ['date_no_year']);
  assert.equal(T.toRpcRows(r.rows)[0].raw, undefined);
  assert.equal(T.csvToRows('nombre;notas\nAna;x').error, 'The file needs an "email" or a "group" column (header in the first row).');
  assert.equal(T.csvToRows('grupo,dias,duracion,hora,hora_fin\nA,Lun,60,7:00,8:30').rows[0].errors[0], 'time_conflict');
});

test('human words for the preview', () => {
  const s = { weekdays: [1, 3], start_time: '07:00', duration_min: 60, start_date: '2026-03-03', end_date: '2026-11-30' };
  assert.equal(T.humanSchedule(s, 'es', 2026), 'Lun y Mié 07:00–08:00, del 3/3 al 30/11');
  assert.equal(T.humanSchedule({ ...s, weekdays: [2, 4, 5], end_date: '2027-02-01' }, 'es', 2026), 'Mar, Jue y Vie 07:00–08:00, del 3/3 al 1/2/2027');
  assert.equal(T.humanSchedule(s, 'en', 2026), 'Mon & Wed 07:00–08:00, Mar 3 – Nov 30');
  assert.equal(T.hmPlus('23:30', 60), '00:30');
});

test('template: schedule columns and Spanish example rows that parse without errors', () => {
  const es = T.templateCsv('es', new Date(2026, 9, 18));
  assert.match(es, /^﻿email,nombre,grupo,docente,unidad,suplente,dias,hora_inicio,hora_fin,desde,hasta,zona\n/);
  assert.match(es, /INEFOP A1\.1 LMi 7:00/);
  const r = T.csvToRows(es);
  assert.equal(r.rows.length, 5);
  assert.ok(r.rows.every(x => !x.errors), JSON.stringify(r.rows.map(x => x.errors)));
  assert.deepEqual(r.rows[0].weekdays, [1, 3]);
  assert.equal(r.rows[0].start_date, '2026-10-25');
  assert.match(T.templateCsv('en'), /^﻿email,name,group,teacher_email,unit,substitute_email,days,start_time,end_time,start_date,end_date,timezone\n/);
});
