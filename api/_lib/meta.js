// Metadata of an AI request (for the super admin's Insights). The browser sends `meta` in the
// /api/generate body; only known values survive (the database cleans them again in ai_meta_clean).
// Institution and user are never taken from the request: the database uses the caller's profile.

export const KINDS = new Set(['generate', 'continue', 'verify', 'student', 'playbook']);
export const LANGUAGES = new Set(['English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian']);
export const AGE_BANDS = new Set(['infant', 'preschool', 'early', 'primary', 'preteen', 'teen', 'olderteen', 'adult', 'mixed']);
export const LEVELS = new Set(['Early Childhood', 'Primary', 'Secondary', 'Intermediate', 'Advanced', 'University', 'Adult Education']);
const MAX_SUBJECTS = 5;
const MAX_SUBJECT_LEN = 60;
const MAX_BARS = 20;
const BAR_KEY = /^[a-z][a-z0-9_]{0,40}$/;

function cleanSubject(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUBJECT_LEN)
    .trim();
}

// Returns { kind, subjects, language, age_band, level, bars } with only whitelisted values.
// `kind` comes from the top-level request field (the one the server already uses): missing → 'generate'
// (same default as the token log), unknown → 'other'.
export function sanitizeMeta(meta, kind) {
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const out = { kind: kind == null || kind === '' ? 'generate' : KINDS.has(kind) ? kind : 'other', subjects: [] };
  if (Array.isArray(m.subjects)) {
    for (const s of m.subjects.slice(0, 20)) {
      if (out.subjects.length >= MAX_SUBJECTS) break;
      if (typeof s !== 'string') continue;
      const c = cleanSubject(s);
      if (c && !out.subjects.some(x => x.toLowerCase() === c.toLowerCase())) out.subjects.push(c);
    }
  }
  if (typeof m.language === 'string' && LANGUAGES.has(m.language)) out.language = m.language;
  if (typeof m.age_band === 'string' && AGE_BANDS.has(m.age_band)) out.age_band = m.age_band;
  if (typeof m.level === 'string' && LEVELS.has(m.level)) out.level = m.level;
  if (m.bars && typeof m.bars === 'object' && !Array.isArray(m.bars)) {
    const bars = {};
    let n = 0;
    for (const [k, v] of Object.entries(m.bars).slice(0, 50)) {
      if (n >= MAX_BARS) break;
      if (!BAR_KEY.test(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
      bars[k] = Math.min(Math.max(Math.round(v), 0), 100);
      n++;
    }
    if (n) out.bars = bars;
  }
  return out;
}
