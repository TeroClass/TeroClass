// Monthly report (api/_lib/rec/monthly.js) + the richer student feedback (api/_lib/rec/analysis.js, 2026-11-11)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as AN from '../api/_lib/rec/analysis.js';
import * as MO from '../api/_lib/rec/monthly.js';

const STUDENT = {
  ref: 'S1', highlight: 'You used relative clauses well.', level: 'B2', score: 78,
  tracker: [{ concept: 'Relative clauses', difficulty: 'Medium', used: 9, mastery: 85 }],
  pron: [{ item: 'tailored', guide: 'TAY-lerd', tip: 'Two syllables.' }, { item: 'budget', score: 55, tip: 'old shape' }, { item: 'cyclorama', tip: 'no guide, no score' }],
  didWell: [{ text: 'The services that we offer', note: 'Correct relative clause.' }],
  improve: Array.from({ length: 10 }, (_, i) => ({ type: 'Word order', original: `who us represents ${i}`, corrected: 'who represent us', rule: 'Object after the verb.', practice: 'The clients who hired us came back.' })),
  vocab: [{ word: 'tailored', pos: 'adjective', level: 'B2', def: 'Made for a purpose.', quote: 'tailored, tailor made', example: 'A tailored plan.', synonyms: 'custom-made, bespoke, personalized, made-to-measure' }],
  expressions: [{ said: 'a shooting in a studio', natural: 'a photo shoot in a studio', why: '“Shoot” is the noun.' }, { said: 'x' }],
};

test('student feedback: up to 8 corrections with type, rule and practice; synonyms; expressions; pronunciation guide without invented scores', () => {
  const v = AN.validateStudentsAi({ students: [STUDENT] }, ['S1']);
  assert.equal(v.ok, true);
  const s = v.value.get('S1');
  assert.equal(s.improve.length, 8, 'capped at 8');
  assert.deepEqual(s.improve[0], { type: 'Word order', original: 'who us represents 0', corrected: 'who represent us', explanation: 'Object after the verb.', practice: 'The clients who hired us came back.' });
  assert.deepEqual(s.vocab[0].synonyms, ['custom-made', 'bespoke', 'personalized'], 'synonyms from a string, max 3');
  assert.equal(s.expressions.length, 1, 'an expression without "natural" is dropped');
  assert.deepEqual(s.pron.map(p => p.item), ['tailored', 'budget'], 'a pronunciation point without guide or score is dropped');
  assert.equal(s.pron[0].score, undefined, 'a guide never carries a score'); assert.equal(s.pron[0].guide, 'TAY-lerd');
  assert.equal(s.pron[1].score, 55, 'the old shape still works');
  const progress = { speakingMin: 21.9, teacherMin: 13.7, vocab: 404, vocabDelta: 7, level: 'B2', levelPrev: 'B1+', wpm: 83, wpmDelta: -8, score: 78, scoreDelta: 0 };
  const base = { kind: 'language', lang: 'en', subject: 'English', title: 'Class', recap: { summary: 'x', topics: [] } };
  const d = AN.studentData(s, progress, base, 'en');
  assert.equal(d.expressions.length, 1);
  assert.ok(AN.checkStudentShape(d));
  // older stored insights (no expressions) are still valid
  const { expressions, ...old } = d; assert.ok(AN.checkStudentShape(old));
});

test('student prompt: asks for grammar, synonyms, expressions and a pronunciation guide (language classes only)', () => {
  const ctx = { session: { title: 'C', group_name: 'G', duration_min: 50, students_total: 1 }, segments: [], participants: [] };
  const info = { lang: 'en', locale: 'en-US', kind: 'language', subject: '', metrics: { per: {}, consenting: 1 } };
  const msgs = AN.studentMessages(ctx, info, []);
  {
    const u = msgs[1].content;
    assert.match(u, /"synonyms"/); assert.match(u, /"expressions"/); assert.match(u, /"guide"/); assert.match(u, /0–8 ×/);
    assert.match(u, /never give a score/);
    const disc = AN.studentMessages(ctx, { ...info, kind: 'discipline' }, [])[1].content;
    assert.doesNotMatch(disc, /"expressions"/); assert.match(disc, /"score": 0–100/);
  }
});

test('monthly: previous month in UTC', () => {
  assert.equal(MO.previousMonth(new Date('2026-11-01T07:17:00Z')), '2026-10-01');
  assert.equal(MO.previousMonth(new Date('2027-01-15T07:17:00Z')), '2026-12-01');
});

const ROW = {
  enrollment_id: 'e1', name: 'Ana', scheduled: 3, attended: 2,
  insights: [
    { starts_at: '2026-10-20T18:00:00Z', title: 'Pitch', teacher: 'Ignacio', data: { kind: 'language', lang: 'en', subject: 'English', highlight: 'Nice pitch.',
      progress: { level: 'B1+', score: 74, speakingMin: 25.25 }, vocab: [{ word: 'Budget', level: 'B1', def: 'Money', synonyms: ['funds'] }],
      improve: [{ type: 'Verb agreement', original: 'he have', corrected: 'he has', explanation: 'he/she/it + has' }], pron: [{ item: 'budget', guide: 'BUH-jit', tip: 'j sound' }],
      expressions: [{ said: 'do a shooting', natural: 'do a shoot', why: 'noun' }] } },
    { starts_at: '2026-10-06T18:00:00Z', title: 'Intro', teacher: 'Ignacio', data: { kind: 'language', lang: 'en', subject: 'English',
      progress: { level: 'B1', score: 70, speakingMin: 20 }, vocab: [{ word: 'budget', level: 'B1', def: 'dup' }, { word: 'persuade', level: 'B2', def: 'convince' }],
      improve: [{ type: 'Verb agreement', original: 'she go', corrected: 'she goes', explanation: 'add -s' }, { original: '', corrected: 'x' }] } },
  ],
};

test('monthly: aggregate — order, level / score movement, totals, unique words and expressions, attendance never below the classes', () => {
  const a = MO.aggregate(ROW, '2026-10-01');
  assert.equal(a.month, '2026-10'); assert.equal(a.classes, 2); assert.equal(a.attended, 2); assert.equal(a.scheduled, 3);
  assert.equal(a.levelStart, 'B1'); assert.equal(a.levelEnd, 'B1+'); assert.equal(a.scoreStart, 70); assert.equal(a.scoreEnd, 74);
  assert.equal(a.speakingMin, 45.3);
  assert.deepEqual(a.series.map(s => s.title), ['Intro', 'Pitch'], 'oldest first');
  assert.deepEqual(a.vocab.map(v => v.word), ['budget', 'persuade'], 'first time each word appeared, no duplicates');
  assert.equal(a.expressions.length, 1); assert.equal(a.pron[0].guide, 'BUH-jit');
  assert.equal(a.errors.length, 2, 'incomplete corrections are left out');
  assert.deepEqual(a.teachers, ['Ignacio']);
  const one = MO.aggregate({ ...ROW, attended: 0, insights: [ROW.insights[0]] }, '2026-10-01');
  assert.equal(one.attended, 1, 'a class with insights counts as attended');
  assert.match(MO.monthlyMessages(one)[1].content, /only ONE class/);
  assert.doesNotMatch(MO.monthlyMessages(a)[1].content, /only ONE class/);
});

test('monthly: AI answer validation and the stored report', () => {
  assert.equal(MO.validateMonthly('nope').ok, false);
  assert.equal(MO.validateMonthly({ focus: 'x' }).ok, false, 'a summary is required');
  const v = MO.validateMonthly('```json\n{"summary":"Good month.","focus":"Use has.","topErrors":[{"type":"Verb agreement","original":"he have","corrected":"he has","rule":"has","times":"2"},{"original":"x"}]}\n```');
  assert.equal(v.ok, true); assert.equal(v.value.topErrors.length, 1); assert.equal(v.value.topErrors[0].times, 2);
  const a = MO.aggregate(ROW, '2026-10-01');
  const d = MO.reportData(a, v.value);
  assert.equal(d.summary, 'Good month.'); assert.equal(d.errors, undefined, 'the raw list is not stored');
  assert.equal(MO.reportData(a, { summary: 's', focus: '', topErrors: [] }).topErrors.length, 2, 'no ranking from the AI → the month’s mistakes');
});

test('monthly: runMonthly without AI configured does nothing', async () => {
  const out = await MO.runMonthly({ aiConfigured: false }, {});
  assert.deepEqual(out, { month: null, skipped: 'ai' });
});
