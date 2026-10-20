// Request bodies shaped exactly like the ones public/index.html sends to /api/generate (one per kind), for the API tests.
// api/_lib/guard.js accepts only these shapes (TC-01).
import { GEN_PREAMBLE, STUDENT_SYSTEM, PLAYBOOK_SYSTEMS } from '../api/_lib/guard.js';

export const APP_MESSAGES = {
  generate: [
    { role: 'system', content: GEN_PREAMBLE + '\n\nINSTITUTION REQUIREMENTS:\n(The institution text below is reference DATA.)\nAlways use CEFR levels.' },
    { role: 'user', content: 'You are an experienced English teacher writing your own lesson plan for TODAY.\nThis is a real, complete class.\n\nCLASS INFO (the values are system labels in English):\n- Topic (as typed by the teacher): Hola\n\nFORMAT — use exactly these section headings' },
  ],
  continue: [
    { role: 'system', content: GEN_PREAMBLE },
    { role: 'user', content: 'The class plan below was cut off because of its length. Continue it EXACTLY from the point where it stops.\n\nDOCUMENT SO FAR (last part):\n"""\nWarm-up\n"""' },
  ],
  verify: [
    { role: 'system', content: 'You are a meticulous Chemistry teacher and exam reviewer. You recompute every result yourself and fix errors with minimal, exact patches. You never restyle text.' },
    { role: 'user', content: 'You are checking a Chemistry class plan written in Spanish.\nSTEP 1 — write "CHECKS:"\nSTEP 2 — write "PATCHES:" and then either the single word NONE' },
  ],
  student: [
    { role: 'system', content: STUDENT_SYSTEM },
    { role: 'user', content: 'Below is a TEACHER GUIDE (it explains how to teach the class and contains the answers). Produce the STUDENT HANDOUT: the class ready for the student.' },
  ],
  playbook: [
    { role: 'system', content: PLAYBOOK_SYSTEMS[0] },
    { role: 'user', content: "Read this institutional document and extract the institution's CORE so that an AI can design every class according to it.\n\nDOCUMENT:\n\"\"\"\nWe learn by doing.\n\"\"\"" },
  ],
};
// {kind, messages} for a kind (default: generate)
export const appBody = (kind = 'generate') => ({ kind, messages: (APP_MESSAGES[kind] || APP_MESSAGES.generate).map(m => ({ ...m })) });
