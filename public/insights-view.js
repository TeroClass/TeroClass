/* TeroClass · Class insights: shared view (no build, vanilla JS)
 * ------------------------------------------------------------------------------------------
 * Renderers for the per-student insights (Summary · Recap · Progress · Feedback · Vocabulary) and the
 * teacher observation report (TEC Observation Guide), plus the sample data and the demo-payload builder.
 * Used by the live-class demo (public/live-class.js, ids prefixed "lc") and by the Insights panels
 * (public/insights-panel.js, ids prefixed "ins"). Every piece of class/user data is escaped and marked
 * data-no-i18n; UI labels are English keys translated by the app dictionary (Spanish below, "vos").
 * Depends on globals from index.html when present: esc, trText, uiLocale, I18N_ES.
 */
(function () {
  'use strict';

  const DEMO_BANNER = 'Demo data — real insights activate when the live classroom is connected';
  const tr = s => (typeof trText === 'function' ? trText(s) : s);
  const E = s => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const initials = name => (String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
  const COLORS = ['#7c5cbf', '#0891b2', '#d97706', '#059669', '#db2777', '#4f46e5', '#b45309', '#0f766e', '#9333ea'];
  const colorFor = s => COLORS[[...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (v == null ? '' : String(v));
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';

  // ════════════════════════════════════════════════════════════════════════════════════════
  // SAMPLE DATA (demo). Real data comes from student_insights / teacher_insights (001_base.sql).
  // ════════════════════════════════════════════════════════════════════════════════════════
  const SAMPLES = {
    language: {
      key: 'language', kind: 'language', lang: 'en',
      title: 'Making plans: future forms (B1)', subject: 'English · B1', durationMin: 45, participants: 8,
      recap: {
        summary: "We practised talking about future plans with 'going to', the present continuous and 'will'. After a warm-up about weekend plans, pairs organised a class trip and presented it to the group.",
        topics: [
          { title: 'Going to vs present continuous', bullets: ["'Going to' for intentions: I'm going to study abroad.", "Present continuous for fixed arrangements: We're meeting at 6.", 'Time expressions: tonight, next week, on Saturday.'] },
          { title: 'Making suggestions', bullets: ["Why don't we…? / How about + -ing?", "Agreeing and disagreeing politely: That sounds great! / I'm not sure about that.", 'Linking ideas: first, then, after that.'] },
          { title: 'Planning the class trip', bullets: ['Pairs chose a destination, a budget and a schedule.', 'Each pair presented their plan in 2 minutes.', 'The class voted for the best plan: a day in Colonia.'] },
        ],
      },
      students: [
        {
          name: 'Valentina Ruiz', highlight: 'Volunteered twice and led the pair’s presentation.',
          progress: { speakingMin: 7.4, teacherMin: 23.1, vocab: 412, vocabDelta: 23, level: 'B1', levelPrev: 'A2+', wpm: 96, wpmDelta: 8, score: 74, scoreDelta: 6 },
          tracker: [
            { concept: 'Going to (intentions)', difficulty: 'Easy', used: 9, updated: 'Today', mastery: 86 },
            { concept: 'Present continuous (arrangements)', difficulty: 'Medium', used: 5, updated: 'Today', mastery: 68 },
            { concept: 'Will (spontaneous decisions)', difficulty: 'Easy', used: 4, updated: 'Today', mastery: 80 },
            { concept: 'How about + -ing', difficulty: 'Medium', used: 3, updated: 'Today', mastery: 55 },
            { concept: 'Prepositions of time (on / at / in)', difficulty: 'Medium', used: 6, updated: '2 classes ago', mastery: 61 },
          ],
          pron: [
            { item: '/θ/ in “think”, “Thursday”', score: 62, tip: 'Put the tip of your tongue between your teeth. You said “tink”.' },
            { item: 'Final -ed /t/ in “booked”', score: 78, tip: 'One syllable: /bʊkt/, not “book-ed”.' },
            { item: 'Word stress: ho-TEL', score: 91, tip: 'Well done — stress on the second syllable.' },
          ],
          didWell: [
            { text: "I'm going to visit my grandmother on Sunday.", note: 'Correct “going to” with a time expression.' },
            { text: "Why don't we take the train? It's cheaper.", note: 'Natural suggestion with a reason.' },
          ],
          improve: [
            { original: 'We are go to the museum tomorrow.', corrected: 'We are going to the museum tomorrow.', explanation: 'The present continuous needs the -ing form: are going.' },
            { original: 'How about to visit Colonia?', corrected: 'How about visiting Colonia?', explanation: 'After “How about” use the -ing form.' },
            { original: 'In Saturday we travel.', corrected: "On Saturday we're travelling.", explanation: 'Use “on” with days, and the present continuous for a fixed plan.' },
          ],
          vocab: [
            { word: 'itinerary', pos: 'noun', level: 'B2', def: 'A detailed plan of a journey.', quote: 'Our itinerary starts in Colonia at nine.', example: 'The travel agent sent us the itinerary.' },
            { word: 'book', pos: 'verb', level: 'A2', def: 'To reserve a seat, room or ticket.', quote: 'We already booked the bus.', example: 'I need to book a table for four.' },
            { word: 'affordable', pos: 'adjective', level: 'B1', def: 'Not expensive; cheap enough to pay for.', quote: 'The hostel is more affordable.', example: 'We found an affordable hotel near the beach.' },
            { word: 'look forward to', pos: 'phrasal verb', level: 'B1', def: 'To feel happy about something that is going to happen.', quote: "I'm looking forward to the trip!", example: "I'm looking forward to the weekend." },
          ],
        },
        {
          name: 'Mateo Fernández', highlight: 'Asked two great follow-up questions during the presentations.',
          progress: { speakingMin: 4.1, teacherMin: 23.1, vocab: 356, vocabDelta: 11, level: 'A2+', levelPrev: 'A2+', wpm: 78, wpmDelta: 3, score: 63, scoreDelta: 4 },
          tracker: [
            { concept: 'Going to (intentions)', difficulty: 'Easy', used: 6, updated: 'Today', mastery: 72 },
            { concept: 'Present continuous (arrangements)', difficulty: 'Medium', used: 2, updated: 'Today', mastery: 45 },
            { concept: 'Will (spontaneous decisions)', difficulty: 'Easy', used: 3, updated: 'Today', mastery: 70 },
            { concept: 'Question forms (What are you doing…?)', difficulty: 'Medium', used: 4, updated: 'Today', mastery: 58 },
          ],
          pron: [
            { item: 'Weak form of “to” /tə/', score: 58, tip: '“going to” sounds like “gonna” in fast speech: /ˈɡəʊɪŋ tə/.' },
            { item: '/v/ vs /b/ in “visit”, “vote”', score: 66, tip: 'Top teeth on the bottom lip for /v/.' },
            { item: 'Intonation in Wh- questions', score: 84, tip: 'Good falling intonation at the end.' },
          ],
          didWell: [
            { text: 'What are you going to do there?', note: 'Correct question with “going to”.' },
            { text: "I'll bring the snacks!", note: 'Natural use of “will” for an offer.' },
          ],
          improve: [
            { original: 'I going to travel in July.', corrected: "I'm going to travel in July.", explanation: 'Don’t forget the verb “be”: I am (I’m) going to…' },
            { original: 'Tomorrow I meet my friends.', corrected: "Tomorrow I'm meeting my friends.", explanation: 'Use the present continuous for arrangements with a time.' },
          ],
          vocab: [
            { word: 'budget', pos: 'noun', level: 'B1', def: 'The amount of money you can spend.', quote: 'Our budget is two thousand pesos.', example: 'We have a small budget for the trip.' },
            { word: 'vote', pos: 'verb', level: 'B1', def: 'To choose officially, often by raising your hand.', quote: 'I vote for Colonia.', example: 'Let’s vote for the best idea.' },
            { word: 'snack', pos: 'noun', level: 'A2', def: 'A small amount of food eaten between meals.', quote: "I'll bring the snacks!", example: 'Fruit is a healthy snack.' },
          ],
        },
        {
          name: 'Sofía Pereira', highlight: 'Excellent fluency; helped a partner with vocabulary.',
          progress: { speakingMin: 6.2, teacherMin: 23.1, vocab: 538, vocabDelta: 19, level: 'B1+', levelPrev: 'B1', wpm: 112, wpmDelta: 5, score: 81, scoreDelta: 3 },
          tracker: [
            { concept: 'Going to (intentions)', difficulty: 'Easy', used: 7, updated: 'Today', mastery: 92 },
            { concept: 'Present continuous (arrangements)', difficulty: 'Medium', used: 6, updated: 'Today', mastery: 84 },
            { concept: 'Will vs going to', difficulty: 'Hard', used: 5, updated: 'Today', mastery: 66 },
            { concept: 'Linking words (first, then, after that)', difficulty: 'Easy', used: 8, updated: 'Today', mastery: 88 },
          ],
          pron: [
            { item: 'Schwa in “travelling”, “museum”', score: 74, tip: 'Reduce unstressed vowels: /ˈtræv(ə)lɪŋ/.' },
            { item: 'Linking: “going_to_a”', score: 81, tip: 'Connect words smoothly in fast speech.' },
            { item: '/h/ in “holiday”, “hotel”', score: 89, tip: 'Clear /h/, not a Spanish “j”.' },
          ],
          didWell: [
            { text: "First we're taking the bus, then we're visiting the old town.", note: 'Sequencing with present continuous — very natural.' },
            { text: "That sounds great, but I'm not sure about the price.", note: 'Polite partial disagreement.' },
          ],
          improve: [
            { original: "I think it's going to rain, so I'm going to take an umbrella… no, I'll take!", corrected: "I'll take an umbrella.", explanation: '“Take” needs an object: take an umbrella.' },
            { original: 'We will to stay two nights.', corrected: 'We will stay two nights.', explanation: 'No “to” after “will”.' },
          ],
          vocab: [
            { word: 'old town', pos: 'noun', level: 'B1', def: 'The historic centre of a city.', quote: "We're visiting the old town.", example: 'The old town has beautiful streets.' },
            { word: 'sightseeing', pos: 'noun', level: 'B1', def: 'Visiting interesting places as a tourist.', quote: 'We need time for sightseeing.', example: 'We went sightseeing in Rome.' },
            { word: 'worth it', pos: 'expression', level: 'B2', def: 'Good enough to justify the cost or effort.', quote: 'The ferry is expensive but it’s worth it.', example: 'The long walk was worth it.' },
          ],
        },
      ],
      teacher: {
        objective: 'Talk about future plans with “going to”, the present continuous and “will”; make and respond to suggestions.',
        observation_focus: 'Student talk time and participation',
        metrics: [
          { label: 'Teacher talk time', value: '52%', sub: '23 of 45 min' },
          { label: 'Student talk time', value: '48%', sub: 'goal ≥ 60%' },
          { label: 'Questions asked', value: '36', sub: '14 open · 22 closed' },
          { label: 'Average wait time', value: '1.8 s', sub: 'after questions' },
          { label: 'Students who spoke', value: '7 / 8', sub: '1 student silent' },
          { label: 'Longest teacher turn', value: '6:40', sub: 'grammar explanation' },
        ],
        highlights: [
          { title: 'Rapport', text: 'You used every student’s name (31 times) and students laughed together during the warm-up (min 2–6).' },
          { title: 'Task setup', text: 'You modelled the trip task with one pair before starting; all pairs started within 40 seconds.' },
        ],
        focus: { title: 'Student talk time', text: 'Teacher talk was 52% (23 min). The future-forms explanation ran 6 min 40 s without student turns (min 9–16).' },
        action: { title: 'Next class', text: 'Replace the explanation with a 3-minute guided discovery: give 6 example sentences and let pairs sort them into “plan” vs “arrangement”.' },
        areas: [
          { area: 'Purpose & Alignment', rating: 'strength', evidence: 'Objectives on screen at min 1; you referred back to them at min 30 (“Remember, arrangements!”).', impact: 'Students knew what success looked like.', next: 'Ask students to self-assess against the objectives in the exit ticket.' },
          { area: 'Rapport', rating: 'strength', evidence: '31 uses of students’ names; 4 moments of shared laughter; Lucas was invited back after being quiet.', impact: 'Safe atmosphere; 7 of 8 students spoke.', next: 'Keep it — add a quick personal check-in for the silent student.' },
          { area: 'STT & Participation', rating: 'focus', evidence: 'Student talk 48% vs goal 60%. Camila did not speak; Valentina spoke 7.4 min, Mateo 4.1 min.', impact: 'Less practice time for the target language.', next: 'Use pair work before whole-class answers; assign roles so quieter students speak first.' },
          { area: 'Instructions & Task Setup', rating: 'strength', evidence: 'Instructions in 3 short steps + model; one ICQ (“Do you write or speak?”).', impact: 'Pairs started in under 40 s.', next: 'Add a time limit on screen.' },
          { area: 'Scaffolding', rating: 'developing', evidence: 'Sentence frames shown for suggestions, but not for disagreeing.', impact: '3 pairs avoided disagreeing politely.', next: 'Add frames: “I see your point, but…”, “What about…?”' },
          { area: 'Language Input', rating: 'developing', evidence: 'Future forms explained in one 6:40 block with 9 example sentences.', impact: 'Attention dropped (2 students turned cameras off).', next: 'Chunk input: 2 minutes, then a quick check, then practice.' },
          { area: 'Monitoring & Feedback', rating: 'strength', evidence: 'You visited 4 of 4 breakout pairs; noted 6 errors for later.', impact: 'Delayed correction kept fluency high.', next: 'Share the error board at the end (it was skipped).' },
          { area: 'Error Correction', rating: 'developing', evidence: '11 corrections, 9 of them recasts; 2 elicited (“Is it ‘go’ or…?”).', impact: 'Recasts are often not noticed: the same error (“are go”) appeared 4 more times.', next: 'Use more elicitation for the target structure.' },
          { area: 'Questions & Interaction', rating: 'developing', evidence: '36 questions: 14 open, 22 closed; average wait time 1.8 s.', impact: 'Short wait time favours the fastest students.', next: 'Wait 3–5 s after open questions; use “think, pair, share”.' },
          { area: 'Pacing & Transitions', rating: 'focus', evidence: 'Activity 1 planned 10 min, took 16; closing planned 5 min, took 2 (exit ticket skipped).', impact: 'No evidence collected at the end of class.', next: 'Set a visible timer per activity (the class plan timer can do this).' },
          { area: 'Materials & Tech', rating: 'strength', evidence: 'Slides and shared map worked; screen share used 2 times without delay.', impact: 'Smooth flow.', next: 'Keep.' },
          { area: 'Personalization', rating: 'strength', evidence: 'Trip destinations came from students’ own ideas (Colonia, Punta del Este).', impact: 'High engagement in Activity 2.', next: 'Link homework to their chosen trip.' },
          { area: 'Evidence of Learning', rating: 'developing', evidence: 'Correct present continuous for arrangements rose from 40% to 68% of attempts during the class.', impact: 'Progress, but the exit ticket was skipped.', next: 'Keep 5 minutes for the exit ticket.' },
        ],
        planVsActual: [
          { section: 'Warm-up: weekend plans', planned: 5, actual: 7, note: 'High engagement; 2 min over.' },
          { section: 'Activity 1: future forms', planned: 10, actual: 16, note: '6:40 teacher explanation without student turns.' },
          { section: 'Activity 2: plan the class trip', planned: 15, actual: 12, note: 'Shortened to recover time.' },
          { section: 'Presentations', planned: 10, actual: 8, note: 'Two pairs did not present.' },
          { section: 'Closing & exit ticket', planned: 5, actual: 2, note: 'Exit ticket skipped.' },
        ],
        form: {
          evidence: 'Teacher talk 52% (23 min); one 6:40 explanation; 36 questions (14 open) with 1.8 s average wait time; exit ticket skipped.',
          worked: 'Warm rapport (names, humour) and a very clear model of the trip task: all pairs started in under 40 seconds.',
          priority: 'Student talk time and pacing of the input stage.',
          next: 'Guided discovery in pairs instead of the explanation, with a 3-minute timer; keep 5 minutes for the exit ticket.',
        },
      },
    },

    chemistry: {
      key: 'chemistry', kind: 'discipline', lang: 'es',
      title: 'Reacciones químicas: balanceo de ecuaciones (3°B)', subject: 'Química · 3°B', durationMin: 50, participants: 8,
      recap: {
        summary: 'Vimos qué es una reacción química, distinguimos reactivos y productos, y comprobamos con una demostración que la masa se conserva. Después balanceamos ecuaciones en parejas.',
        topics: [
          { title: 'Reactivos y productos', bullets: ['Los reactivos están a la izquierda de la flecha; los productos, a la derecha.', 'La flecha se lee “produce” o “da”.', 'Ejemplo: CH₄ + 2O₂ → CO₂ + 2H₂O.'] },
          { title: 'Ley de conservación de la masa', bullets: ['La masa total antes y después de la reacción es la misma.', 'En la bolsa cerrada la balanza marcó 152 g antes y después.', 'Si la bolsa está abierta, el gas se escapa y parece que “se pierde” masa.'] },
          { title: 'Balanceo de ecuaciones', bullets: ['Se cuentan los átomos de cada elemento a cada lado.', 'Solo se cambian coeficientes, nunca subíndices.', '2H₂ + O₂ → 2H₂O quedó balanceada en clase.'] },
        ],
      },
      students: [
        {
          name: 'Valentina Ruiz', highlight: 'Explicó al grupo por qué la masa no cambia en la bolsa cerrada.',
          progress: { speakingMin: 5.8, teacherMin: 24.5, vocab: 14, vocabDelta: 6, level: 'Explica con sus palabras', levelPrev: 'Explica con apoyo', wpm: 4, wpmDelta: 2, score: 82, scoreDelta: 9 },
          tracker: [
            { concept: 'Reactivo / producto', difficulty: 'Básico', used: 7, updated: 'Hoy', mastery: 90 },
            { concept: 'Conservación de la masa', difficulty: 'Intermedio', used: 5, updated: 'Hoy', mastery: 85 },
            { concept: 'Coeficiente vs subíndice', difficulty: 'Intermedio', used: 4, updated: 'Hoy', mastery: 70 },
            { concept: 'Balanceo por tanteo', difficulty: 'Avanzado', used: 3, updated: 'Hoy', mastery: 62 },
          ],
          pron: [
            { item: 'Conservación de la masa', score: 90, tip: 'La usó bien para explicar la demostración.' },
            { item: 'Coeficiente vs subíndice', score: 70, tip: 'Una vez cambió un subíndice (H₂O → H₂O₂) al balancear.' },
            { item: 'Reactivo / producto', score: 95, tip: 'Identificó correctamente todos los reactivos y productos.' },
          ],
          didWell: [
            { text: 'La masa no cambia porque los átomos se reorganizan, no desaparecen.', note: 'Explicación correcta de la conservación de la masa a nivel de partículas.' },
            { text: 'El metano y el oxígeno son los reactivos.', note: 'Uso preciso de “reactivo”.' },
          ],
          improve: [
            { original: 'Le pongo un 2 abajo al oxígeno del agua: H₂O₂.', corrected: 'Pongo un coeficiente delante: 2H₂O.', explanation: 'Cambiar el subíndice crea otra sustancia (agua oxigenada). Solo se cambian coeficientes.' },
            { original: 'El gas se evaporó y por eso pesa menos.', corrected: 'El gas salió de la bolsa abierta, por eso la balanza marca menos.', explanation: 'La masa no se destruye: el gas escapó del sistema.' },
          ],
          vocab: [
            { word: 'reactivo', pos: 'sustantivo', level: 'Básico', def: 'Sustancia que se transforma en una reacción química.', quote: 'El metano y el oxígeno son los reactivos.', example: 'En la combustión, el oxígeno es un reactivo.' },
            { word: 'coeficiente', pos: 'sustantivo', level: 'Intermedio', def: 'Número delante de una fórmula que indica cuántas moléculas hay.', quote: 'Le agrego un coeficiente 2 al agua.', example: 'En 2H₂O el coeficiente es 2.' },
            { word: 'subíndice', pos: 'sustantivo', level: 'Intermedio', def: 'Número pequeño dentro de una fórmula que indica cuántos átomos de un elemento hay.', quote: 'El subíndice no se toca.', example: 'En CO₂ el subíndice del oxígeno es 2.' },
            { word: 'sistema cerrado', pos: 'concepto', level: 'Avanzado', def: 'Sistema que no intercambia materia con el exterior.', quote: 'Con la bolsa cerrada es un sistema cerrado.', example: 'Un frasco tapado es un sistema cerrado.' },
          ],
        },
        {
          name: 'Mateo Fernández', highlight: 'Hizo la pregunta clave: “¿adónde fue el gas?”.',
          progress: { speakingMin: 3.2, teacherMin: 24.5, vocab: 9, vocabDelta: 3, level: 'Explica con apoyo', levelPrev: 'Explica con apoyo', wpm: 3, wpmDelta: 1, score: 64, scoreDelta: 5 },
          tracker: [
            { concept: 'Reactivo / producto', difficulty: 'Básico', used: 4, updated: 'Hoy', mastery: 75 },
            { concept: 'Conservación de la masa', difficulty: 'Intermedio', used: 2, updated: 'Hoy', mastery: 55 },
            { concept: 'Coeficiente vs subíndice', difficulty: 'Intermedio', used: 3, updated: 'Hoy', mastery: 48 },
          ],
          pron: [
            { item: 'Reactivo / producto', score: 75, tip: 'Una vez llamó “producto” al oxígeno.' },
            { item: 'Conservación de la masa', score: 55, tip: 'Dijo que la masa “se pierde” cuando sale el gas.' },
            { item: 'Coeficiente vs subíndice', score: 48, tip: 'Confunde los dos términos al explicar.' },
          ],
          didWell: [
            { text: '¿Adónde fue el gas cuando abrimos la bolsa?', note: 'Pregunta que llevó a toda la clase a la idea de sistema cerrado.' },
          ],
          improve: [
            { original: 'La masa se pierde cuando sale el gas.', corrected: 'La masa se conserva; el gas sale del sistema y la balanza no lo mide.', explanation: 'La materia no se destruye: cambia de lugar o de forma.' },
            { original: 'El subíndice es el número grande de adelante.', corrected: 'El coeficiente es el número de adelante; el subíndice es el pequeño de abajo.', explanation: 'Coeficiente = cantidad de moléculas; subíndice = átomos dentro de la molécula.' },
          ],
          vocab: [
            { word: 'producto', pos: 'sustantivo', level: 'Básico', def: 'Sustancia que se forma en una reacción química.', quote: 'El agua es un producto.', example: 'El CO₂ es un producto de la combustión.' },
            { word: 'balanza', pos: 'sustantivo', level: 'Básico', def: 'Instrumento para medir la masa.', quote: 'La balanza marcaba 152 gramos.', example: 'Usamos la balanza antes y después.' },
            { word: 'gas', pos: 'sustantivo', level: 'Básico', def: 'Estado de la materia sin forma ni volumen propios.', quote: '¿Adónde fue el gas?', example: 'El dióxido de carbono es un gas.' },
          ],
        },
        {
          name: 'Sofía Pereira', highlight: 'Balanceó la ecuación del metano sin ayuda y la explicó en la pizarra.',
          progress: { speakingMin: 4.9, teacherMin: 24.5, vocab: 17, vocabDelta: 5, level: 'Explica y justifica', levelPrev: 'Explica con sus palabras', wpm: 2, wpmDelta: 0, score: 91, scoreDelta: 4 },
          tracker: [
            { concept: 'Coeficiente vs subíndice', difficulty: 'Intermedio', used: 6, updated: 'Hoy', mastery: 94 },
            { concept: 'Balanceo por tanteo', difficulty: 'Avanzado', used: 5, updated: 'Hoy', mastery: 88 },
            { concept: 'Conservación de la masa', difficulty: 'Intermedio', used: 3, updated: 'Hoy', mastery: 86 },
          ],
          pron: [
            { item: 'Balanceo por tanteo', score: 88, tip: 'Explicó el orden: primero C, luego H, al final O.' },
            { item: 'Coeficiente vs subíndice', score: 94, tip: 'Uso preciso de ambos términos.' },
            { item: 'Combustión', score: 72, tip: 'Dijo “quemar es destruir”; revisar la idea de transformación.' },
          ],
          didWell: [
            { text: 'Primero balanceo el carbono, después el hidrógeno y al final el oxígeno.', note: 'Estrategia de balanceo clara y justificada.' },
            { text: 'Si cambio el subíndice ya no es agua, es otra sustancia.', note: 'Comprende por qué no se tocan los subíndices.' },
          ],
          improve: [
            { original: 'Cuando algo se quema, se destruye.', corrected: 'Cuando algo se quema, se transforma en otras sustancias (CO₂ y H₂O).', explanation: 'En una reacción química los átomos se reorganizan; nada se destruye.' },
          ],
          vocab: [
            { word: 'combustión', pos: 'sustantivo', level: 'Intermedio', def: 'Reacción de una sustancia con oxígeno que libera energía.', quote: 'La combustión del metano da CO₂ y agua.', example: 'La vela se apaga cuando no hay oxígeno para la combustión.' },
            { word: 'ecuación química', pos: 'concepto', level: 'Intermedio', def: 'Representación de una reacción con fórmulas y una flecha.', quote: 'La ecuación química ya está balanceada.', example: 'H₂ + O₂ → H₂O es una ecuación química sin balancear.' },
            { word: 'por tanteo', pos: 'expresión', level: 'Avanzado', def: 'Método de balanceo probando coeficientes hasta igualar los átomos.', quote: 'Lo balanceé por tanteo.', example: 'Balanceamos la ecuación por tanteo.' },
          ],
        },
      ],
      teacher: {
        objective: 'Reconocer reactivos y productos y balancear ecuaciones aplicando la conservación de la masa.',
        observation_focus: 'Corrección de concepciones erróneas',
        metrics: [
          { label: 'Teacher talk time', value: '49%', sub: '24,5 de 50 min' },
          { label: 'Student talk time', value: '51%', sub: 'meta ≥ 50%' },
          { label: 'Questions asked', value: '29', sub: '12 abiertas · 17 cerradas' },
          { label: 'Average wait time', value: '2,6 s', sub: 'después de preguntar' },
          { label: 'Students who spoke', value: '6 / 8', sub: '2 sin intervenir' },
          { label: 'Longest teacher turn', value: '4:10', sub: 'explicación de balanceo' },
        ],
        highlights: [
          { title: 'Indagación', text: 'La demostración de la bolsa cerrada generó 9 hipótesis de estudiantes antes de pesar (min 12–19).' },
          { title: 'Preguntas', text: '12 preguntas abiertas del tipo “¿por qué…?” y espera promedio de 2,6 s.' },
        ],
        focus: { title: 'Corrección de concepciones erróneas', text: 'La idea “la masa se pierde” apareció 5 veces y se corrigió con la respuesta correcta en 4 de ellas, sin que el estudiante la reformulara.' },
        action: { title: 'Próxima clase', text: 'Ante una concepción errónea, pedir a otro estudiante que la contraste con la evidencia (152 g antes y después) y que el autor la reformule.' },
        areas: [
          { area: 'Purpose & Alignment', rating: 'strength', evidence: 'Objetivos leídos al inicio y retomados en el cierre (min 46).', impact: 'Los estudiantes vincularon la demostración con el objetivo.', next: 'Pedir que cada estudiante escriba qué objetivo logró.' },
          { area: 'Rapport', rating: 'strength', evidence: 'Clima distendido; 3 estudiantes pidieron la palabra espontáneamente.', impact: 'Se animaron a proponer hipótesis equivocadas.', next: 'Mantener.' },
          { area: 'STT & Participation', rating: 'developing', evidence: 'Habla estudiantil 51%; Camila y Joaquín no intervinieron.', impact: 'Dos estudiantes sin evidencia de aprendizaje oral.', next: 'Asignar roles en parejas (quien balancea / quien explica).' },
          { area: 'Instructions & Task Setup', rating: 'strength', evidence: 'Consigna de balanceo con un ejemplo resuelto en la pizarra.', impact: 'Todas las parejas comenzaron en menos de 1 minuto.', next: 'Mostrar el tiempo disponible.' },
          { area: 'Scaffolding', rating: 'strength', evidence: 'Tabla de conteo de átomos por elemento entregada en la Actividad 2.', impact: '7 de 8 parejas balancearon la primera ecuación.', next: 'Retirar la tabla gradualmente en la próxima clase.' },
          { area: 'Language Input', rating: 'developing', evidence: '“Coeficiente” y “subíndice” se definieron oralmente pero no quedaron escritos.', impact: 'Mateo confundió los términos 3 veces.', next: 'Dejar un glosario visible con ejemplo de cada término.' },
          { area: 'Monitoring & Feedback', rating: 'strength', evidence: 'Recorriste 4 de 4 grupos y diste feedback específico (“contá los oxígenos otra vez”).', impact: 'Las parejas corrigieron sus propios errores.', next: 'Mantener.' },
          { area: 'Error Correction', rating: 'focus', evidence: '“La masa se pierde” apareció 5 veces; en 4 diste la respuesta correcta directamente.', impact: 'La concepción errónea reapareció en el ticket de salida.', next: 'Devolver la pregunta al grupo y pedir que el estudiante reformule.' },
          { area: 'Questions & Interaction', rating: 'strength', evidence: '29 preguntas, 12 abiertas; espera promedio 2,6 s.', impact: 'Respuestas más elaboradas.', next: 'Subir la espera a 3–5 s en preguntas de “¿por qué?”.' },
          { area: 'Pacing & Transitions', rating: 'developing', evidence: 'Actividad 1 planificada en 15 min, duró 19; cierre en 3 min.', impact: 'Ticket de salida apurado.', next: 'Usar el temporizador del plan por actividad.' },
          { area: 'Materials & Tech', rating: 'strength', evidence: 'Video y simulador funcionaron; la cámara mostró bien la balanza.', impact: 'Todos vieron la medición.', next: 'Mantener.' },
          { area: 'Personalization', rating: 'developing', evidence: 'Un solo nivel de ecuaciones para todos.', impact: 'Sofía terminó en 4 min y esperó.', next: 'Preparar una ecuación de desafío (C₃H₈ + O₂).' },
          { area: 'Evidence of Learning', rating: 'developing', evidence: 'Ticket de salida: 6 de 8 respuestas correctas sobre subíndices.', impact: '2 estudiantes todavía cambian subíndices.', next: 'Retomar con esos 2 estudiantes al inicio de la próxima clase.' },
        ],
        planVsActual: [
          { section: 'Inicio: ¿qué pasa cuando algo se quema?', planned: 10, actual: 9, note: 'Buena lluvia de ideas.' },
          { section: 'Actividad 1: conservación de la masa', planned: 15, actual: 19, note: 'Las hipótesis llevaron más tiempo (valioso).' },
          { section: 'Actividad 2: balanceo en parejas', planned: 20, actual: 19, note: '7 de 8 parejas completaron.' },
          { section: 'Cierre y ticket de salida', planned: 5, actual: 3, note: 'Ticket apurado.' },
        ],
        form: {
          evidence: '9 hipótesis de estudiantes antes de la medición; 12 preguntas abiertas; “la masa se pierde” apareció 5 veces y se corrigió directamente en 4.',
          worked: 'La demostración en bolsa cerrada y la tabla de conteo de átomos: 7 de 8 parejas balancearon la primera ecuación.',
          priority: 'Corrección de concepciones erróneas.',
          next: 'Devolver la concepción errónea al grupo, contrastar con la evidencia y pedir que el estudiante la reformule.',
        },
      },
    },
  };

  // Which sample fits a class: language classes vs other subjects (concepts and disciplinary language)
  function pickSampleKey(planning) {
    const p = (planning && planning.params) || {};
    const subj = [(p.subjects || []).join(' '), (planning && planning.title) || '', (planning && planning.group) || ''].join(' ');
    if (/chem|qu[ií]m|scien|cienc|f[ií]sic|physic|biolog|matem|math|histor|geogra/i.test(subj)) return 'chemistry';
    if (/english|ingl[eé]s|language|idioma|\besl\b|\befl\b|french|franc[eé]s|portugu|italian|german|alem[aá]n/i.test(subj)) return 'language';
    return p.language === 'Spanish' ? 'chemistry' : 'language';
  }

  const banner = compact => `<div class="lc-banner${compact ? ' compact' : ''}" role="note"><span aria-hidden="true">🧪</span> <span>${DEMO_BANNER}</span></div>`;
  const demoChip = () => '<span class="lc-chip lc-chip-demo">Demo</span>';

  // ════════════════════════════════════════════════════════════════════════════════════════
  // MODEL: one shape for samples and stored rows (missing fields never break the view)
  // ════════════════════════════════════════════════════════════════════════════════════════
  function normRecap(r) {
    r = obj(r);
    return { summary: str(r.summary), topics: arr(r.topics).map(t => ({ title: str(obj(t).title), bullets: arr(obj(t).bullets).map(str) })) };
  }
  function normStudent(s) {
    s = obj(s); const p = obj(s.progress);
    return {
      ...s, name: str(s.name), highlight: str(s.highlight), recap: s.recap ? normRecap(s.recap) : null,
      progress: { speakingMin: num(p.speakingMin), teacherMin: num(p.teacherMin), vocab: num(p.vocab), vocabDelta: num(p.vocabDelta),
        level: str(p.level), levelPrev: str(p.levelPrev), wpm: num(p.wpm), wpmDelta: num(p.wpmDelta), score: num(p.score), scoreDelta: num(p.scoreDelta) },
      tracker: arr(s.tracker).map(obj), pron: arr(s.pron).map(obj), didWell: arr(s.didWell).map(obj), improve: arr(s.improve).map(obj), vocab: arr(s.vocab).map(obj),
    };
  }
  function normTeacher(t) {
    if (!t) return null; t = obj(t);
    return { objective: str(t.objective), observation_focus: str(t.observation_focus), metrics: arr(t.metrics).map(obj), highlights: arr(t.highlights).map(obj),
      focus: obj(t.focus), action: obj(t.action), areas: arr(t.areas).map(obj), planVsActual: arr(t.planVsActual).map(obj), form: obj(t.form) };
  }
  function model(x) {
    x = obj(x);
    return { key: str(x.key || 'x'), kind: x.kind === 'discipline' ? 'discipline' : 'language', lang: str(x.lang || 'en'), title: str(x.title), subject: str(x.subject),
      durationMin: num(x.durationMin || x.duration_min), participants: num(x.participants), recap: normRecap(x.recap),
      students: arr(x.students).map(normStudent), teacher: normTeacher(x.teacher) };
  }
  const SAMPLE_MODELS = {};
  const sampleModel = k => SAMPLE_MODELS[k] || (SAMPLE_MODELS[k] = model(SAMPLES[k] || SAMPLES.language));
  // get_session_insights(...) → model (students carry their row: _row = {id, teacher_message, published_message, published_at})
  function modelFromSession(d) {
    d = obj(d); const s = obj(d.session); const t = d.teacher ? obj(d.teacher.data) : null;
    const rows = arr(d.students); const base = t && Object.keys(t).length ? t : obj(rows[0] && rows[0].data);
    return model({ key: 'sess:' + str(s.id), kind: base.kind, lang: base.lang, title: s.title || base.title, subject: base.subject, durationMin: s.duration_min,
      participants: s.students_total, recap: base.recap, teacher: t,
      students: rows.map(r => ({ ...obj(r.data), name: r.name, _row: r })) });
  }
  // my_insight(...) → model with one student
  function modelFromStudent(d) {
    d = obj(d); const data = obj(d.data); const s = obj(d.session);
    return model({ key: 'mine:' + str(d.id), kind: data.kind, lang: data.lang, title: s.title || data.title, subject: data.subject, durationMin: s.duration_min,
      recap: data.recap, teacher: null, students: [{ ...data, name: d.student_name || '' }] });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // STUDENT INSIGHTS: Summary · Recap · Progress · Feedback · Vocabulary
  // ════════════════════════════════════════════════════════════════════════════════════════
  const LABELS = {
    language: {
      metrics: ['Speaking time', 'Vocabulary size', 'Speaking level (CEFR)', 'Words per minute', 'Grammar score'],
      tracker: 'Grammar tracker', feedbackA: 'Pronunciation', feedbackB: 'Grammar', vocab: 'Vocabulary',
      vocabCols: ['Word', 'Part of speech', 'CEFR', 'Definition', 'From the lesson', 'Example'],
    },
    discipline: {
      metrics: ['Speaking time', 'Subject terms used', 'Explanation level', 'Questions asked', 'Concept accuracy'],
      tracker: 'Concept tracker', feedbackA: 'Concept use', feedbackB: 'Terms and reasoning', vocab: 'Key terms',
      vocabCols: ['Term', 'Type', 'Level', 'Definition', 'From the lesson', 'Example'],
    },
  };
  const SUBTABS = [['overview', 'Summary'], ['recap', 'Recap'], ['progress', 'Progress'], ['feedback', 'Feedback'], ['vocab', 'Vocabulary']];
  const D = s => `<span data-no-i18n>${E(s)}</span>`; // class/user data: never translated
  const dec = (v, lang) => String(Math.round(num(v) * 10) / 10).replace('.', lang === 'es' ? ',' : '.');
  const delta = (v, unit = '') => v > 0 ? `<span class="lc-delta up">▲ <span data-no-i18n>${v}${unit}</span></span>` : v < 0 ? `<span class="lc-delta down">▼ <span data-no-i18n>${Math.abs(v)}${unit}</span></span>` : '<span class="lc-delta">= <span>no change</span></span>';
  const fmtWhen = d => { try { return new Date(d).toLocaleString(typeof uiLocale === 'function' ? uiLocale() : undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };

  function studentPickerHtml(X, idx, P) {
    return `<div class="lc-student-pick" role="group" aria-label="${E(tr('Choose a student'))}">
        ${X.students.map((s, i) => `<button type="button" class="lc-person-chip${i === idx ? ' active' : ''}" data-lc="pick-student" data-i="${i}" id="${P}-pick-${i}" aria-pressed="${i === idx}"><span class="lc-avatar xs" style="background:${colorFor(s.name)}" aria-hidden="true" data-no-i18n>${E(initials(s.name))}</span> <span data-no-i18n>${E(s.name)}</span>${s._row && s._row.published_at ? ' <span class="ins-dot-ok" title="' + E(tr('Message published')) + '" aria-label="' + E(tr('Message published')) + '">✓</span>' : ''}</button>`).join('')}
      </div>`;
  }
  function subtabsHtml(X, sub, P) {
    return `<div class="lc-subtabs" role="tablist" aria-label="${E(tr('Student insights'))}">
        ${SUBTABS.map(([k, l]) => `<button type="button" role="tab" class="lc-subtab${sub === k ? ' active' : ''}" aria-selected="${sub === k}" data-lc="ins-sub" data-k="${k}" id="${P}-sub-${k}">${k === 'vocab' ? LABELS[X.kind].vocab : l}</button>`).join('')}
      </div>`;
  }
  function metricCards(X, st) {
    const p = st.progress; const L = LABELS[X.kind];
    const tot = p.speakingMin + p.teacherMin; const studentPct = tot ? Math.round(p.speakingMin / tot * 100) : 0;
    return [
      { label: L.metrics[0], value: `${dec(p.speakingMin, X.lang)} min`, extra: `<span data-no-i18n>${studentPct}%</span> <span>of class talk</span>` },
      { label: L.metrics[1], value: String(p.vocab), extra: delta(p.vocabDelta) },
      { label: L.metrics[2], value: p.level || '—', extra: p.levelPrev && p.levelPrev !== p.level ? `<span class="lc-delta up">▲ <span>from</span> <span data-no-i18n>${E(p.levelPrev)}</span></span>` : delta(0) },
      { label: L.metrics[3], value: String(p.wpm), extra: delta(p.wpmDelta) },
      { label: L.metrics[4], value: `${p.score}%`, extra: delta(p.scoreDelta, '%') },
    ];
  }
  const metricHtml = m => `<div class="lc-metric"><div class="lc-metric-lb">${m.label}</div><div class="lc-metric-v" data-no-i18n>${E(m.value)}</div><div class="lc-metric-x">${m.extra}</div></div>`;

  // Message from the teacher. o.msg.mode: 'demo' (live sample, not sent) · 'edit' (teacher: draft → publish)
  // · 'read' (admin) · 'student' (only the published message)
  function msgBoxHtml(X, st, idx, o) {
    const P = o.P; const M = o.msg || { mode: 'demo' }; const first = firstName(st.name);
    if (M.mode === 'student') {
      return `<section class="lc-card lc-msgbox ins-msg-student">
        <h3><span aria-hidden="true">💬</span> <span>Message from your teacher</span></h3>
        ${M.published ? `<p class="ins-msg-text" data-no-i18n>${E(M.published)}</p>${M.publishedAt ? `<p class="lc-fine" data-no-i18n>${E(fmtWhen(M.publishedAt))}</p>` : ''}`
          : '<p class="lc-empty">Your teacher hasn’t sent you a message for this class yet.</p>'}
      </section>`;
    }
    const head = `<h3>Message to <span data-no-i18n>${E(first)}</span></h3>`;
    const pubBlock = M.published ? `<div class="ins-msg-status ok" id="${P}-msg-status"><span aria-hidden="true">✓</span> <span>Published</span> <span data-no-i18n>${E(fmtWhen(M.publishedAt))}</span> · <span>the student can see it</span></div>
        <div class="ins-msg-pub"><div class="lc-fine">What the student sees:</div><p class="ins-msg-text" data-no-i18n>${E(M.published)}</p></div>` : '';
    if (M.mode === 'read') {
      return `<section class="lc-card lc-msgbox">${head}
        ${pubBlock || '<p class="lc-empty" id="' + P + '-msg-status">The teacher hasn’t published a message for this student yet.</p>'}
        <p class="lc-fine">Read-only: only the teacher of the group writes these messages.</p></section>`;
    }
    const ta = `<label class="lc-sr" for="${P}-teacher-msg">Message to the student</label>
        <textarea id="${P}-teacher-msg" rows="5" maxlength="4000" placeholder="Write a personal note for this student…" data-key="${E(M.key || '')}">${E(M.text || '')}</textarea>`;
    if (M.mode === 'edit') {
      const changed = M.published && str(M.text).trim() !== str(M.published).trim();
      return `<section class="lc-card lc-msgbox">${head}${ta}
        <div class="lc-row">
          <button type="button" class="lc-btn" data-lc="draft-msg" id="${P}-draft-msg">✨ Draft with assistant</button>
          <button type="button" class="lc-btn" data-lc="save-msg" id="${P}-save-msg">Save draft</button>
          <button type="button" class="lc-btn lc-primary" data-lc="publish-msg" id="${P}-publish-msg">${M.published ? 'Publish changes' : 'Publish to student'}</button>
        </div>
        ${pubBlock || `<div class="ins-msg-status" id="${P}-msg-status">Draft: the student can’t see it until you publish it.</div>`}
        ${changed ? '<p class="lc-fine ins-msg-changed">You have changes that are not published yet.</p>' : ''}
      </section>`;
    }
    return `<section class="lc-card lc-msgbox">${head}${ta}
        <div class="lc-row">
          <button type="button" class="lc-btn" data-lc="draft-msg" id="${P}-draft-msg">✨ Draft with assistant</button>
          <button type="button" class="lc-btn lc-primary" data-lc="send-msg">Send to student</button>
        </div>
        <p class="lc-fine">Demo: messages are not sent.</p>
      </section>`;
  }
  function overviewHtml(X, st, idx, o) {
    return `<div class="lc-grid-2">
      ${msgBoxHtml(X, st, idx, o)}
      <section class="lc-card">
        <h3>Highlight</h3>
        ${st.highlight ? `<p class="lc-quote" data-no-i18n>${E(st.highlight)}</p>` : '<p class="lc-empty">—</p>'}
        <h3>At a glance</h3>
        <div class="lc-metrics compact">${metricCards(X, st).map(metricHtml).join('')}</div>
      </section>
    </div>`;
  }
  function recapHtml(X, st) {
    const R = st.recap || X.recap;
    return `<section class="lc-card lc-recap">
      <h3>Class summary</h3>
      ${R.summary ? `<p class="lc-lead" data-no-i18n>${E(R.summary)}</p>` : ''}
      ${R.topics.length ? `<h4 class="ins-topics-h">Topics covered</h4>
      <ol class="lc-topics">${R.topics.map((t, i) => `<li class="lc-topic"><span class="lc-topic-n" aria-hidden="true">${i + 1}</span><div><h4 data-no-i18n>${E(t.title)}</h4><ul>${t.bullets.map(b => `<li data-no-i18n>${E(b)}</li>`).join('')}</ul></div></li>`).join('')}</ol>` : ''}
    </section>`;
  }
  function progressHtml(X, st) {
    const p = st.progress; const L = LABELS[X.kind];
    const tot = p.speakingMin + p.teacherMin; const sp = tot ? Math.round(p.speakingMin / tot * 100) : 0;
    return `<div class="lc-metrics">${metricCards(X, st).map(metricHtml).join('')}</div>
      <section class="lc-card">
        <h3>Speaking time</h3>
        <div class="lc-split" role="img" aria-label="${E(`${tr('Student')} ${sp}% · ${tr('Teacher')} ${100 - sp}%`)}">
          <span class="lc-split-a" style="width:${sp}%"></span><span class="lc-split-b" style="width:${100 - sp}%"></span>
        </div>
        <div class="lc-split-legend"><span><i class="lc-dot a"></i> <span data-no-i18n>${E(firstName(st.name) || tr('Student'))}</span> · <b data-no-i18n>${dec(p.speakingMin, X.lang)} min (${sp}%)</b></span>
          <span><i class="lc-dot b"></i> <span>Teacher</span> · <b data-no-i18n>${dec(p.teacherMin, X.lang)} min (${100 - sp}%)</b></span></div>
      </section>
      <section class="lc-card">
        <h3>${L.tracker}</h3>
        ${st.tracker.length ? `<div class="lc-table-wrap"><table class="lc-table">
          <thead><tr><th scope="col">Concept</th><th scope="col">Difficulty</th><th scope="col">Used</th><th scope="col">Updated</th><th scope="col">Mastery</th></tr></thead>
          <tbody>${st.tracker.map(r => { const m = Math.max(0, Math.min(100, num(r.mastery))); return `<tr><td data-no-i18n>${E(r.concept)}</td><td><span class="lc-chip lc-diff-${E(str(r.difficulty).toLowerCase().replace(/[^a-záéíóú]/g, ''))}">${E(r.difficulty)}</span></td><td data-no-i18n>${num(r.used)}×</td><td>${E(r.updated)}</td>
            <td><div class="lc-mastery"><div class="lc-progress"><span style="width:${m}%" class="${m >= 80 ? 'good' : m >= 60 ? 'mid' : 'low'}"></span></div><b data-no-i18n>${m}%</b></div></td></tr>`; }).join('')}</tbody>
        </table></div>` : '<p class="lc-empty">—</p>'}
      </section>`;
  }
  function feedbackHtml(X, st) {
    const L = LABELS[X.kind];
    return `<section class="lc-card">
        <h3>${L.feedbackA}</h3>
        <div class="lc-pron">${st.pron.map(p => { const sc = Math.max(0, Math.min(100, num(p.score))); return `<div class="lc-pron-card">
          <div class="lc-ring" style="--p:${sc}" role="img" aria-label="${sc}%"><span data-no-i18n>${sc}%</span></div>
          <div><div class="lc-pron-item" data-no-i18n>${E(p.item)}</div><div class="lc-pron-tip" data-no-i18n>${E(p.tip)}</div></div></div>`; }).join('')}</div>
      </section>
      <div class="lc-grid-2">
        <section class="lc-card lc-good">
          <h3>✅ <span>What you did well</span></h3>
          ${st.didWell.map(d => `<div class="lc-fb"><div class="lc-fb-quote" data-no-i18n>“${E(d.text)}”</div><div class="lc-fb-note" data-no-i18n>${E(d.note)}</div></div>`).join('') || '<p class="lc-empty">—</p>'}
        </section>
        <section class="lc-card lc-improve">
          <h3>🎯 <span>What you can improve</span></h3>
          ${st.improve.map(d => `<div class="lc-fb"><div class="lc-fix"><span class="lc-wrong" data-no-i18n>${E(d.original)}</span> <span aria-hidden="true">→</span><span class="lc-sr">corrected:</span> <span class="lc-right" data-no-i18n>${E(d.corrected)}</span></div><div class="lc-fb-note" data-no-i18n>${E(d.explanation)}</div></div>`).join('') || '<p class="lc-empty">—</p>'}
        </section>
      </div>
      <p class="lc-fine"><span>${L.feedbackB}</span>: <span>based on the student’s own microphone track.</span></p>`;
  }
  function vocabHtml(X, st) {
    const C = LABELS[X.kind].vocabCols;
    return `<section class="lc-card">
      <h3>${LABELS[X.kind].vocab}</h3>
      <div class="lc-vocab">${st.vocab.map(v => `<article class="lc-vocab-card">
        <header><b class="lc-vocab-word" data-no-i18n>${E(v.word)}</b> <span class="lc-chip" title="${E(tr(C[1]))}" data-no-i18n>${E(v.pos)}</span> <span class="lc-chip lc-chip-lvl" title="${E(tr(C[2]))}" data-no-i18n>${E(v.level)}</span></header>
        <dl>
          <dt>${C[3]}</dt><dd data-no-i18n>${E(v.def)}</dd>
          <dt>${C[4]}</dt><dd class="lc-quote" data-no-i18n>“${E(v.quote)}”</dd>
          <dt>${C[5]}</dt><dd data-no-i18n>${E(v.example)}</dd>
        </dl></article>`).join('') || '<p class="lc-empty">—</p>'}</div>
    </section>`;
  }
  // Student view: optional picker + sub-tabs + body. o = {P, picker, msg}
  function studentTabsHtml(X, idx, sub, o) {
    o = o || {}; const P = o.P || 'lc';
    if (!X.students.length) return '<p class="lc-empty">No student insights for this class.</p>';
    idx = Math.max(0, Math.min(idx || 0, X.students.length - 1));
    if (!SUBTABS.some(([k]) => k === sub)) sub = 'overview';
    const st = X.students[idx];
    const body = ({ overview: overviewHtml, recap: recapHtml, progress: progressHtml, feedback: feedbackHtml, vocab: vocabHtml })[sub](X, st, idx, { ...o, P });
    return `${o.picker === false ? '' : studentPickerHtml(X, idx, P)}${subtabsHtml(X, sub, P)}<div class="lc-sub-body" role="tabpanel" aria-labelledby="${P}-sub-${sub}">${body}</div>`;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // TEACHER OBSERVATION REPORT (TEC Observation Guide)
  // Header → Evidence I noticed → What worked well → Priority area → Suggested next step → Teacher reflection
  // o = {P, header:{teacher,group,date,objective,focus,students,duration}, live, fields:{editable, values},
  //      reflection:{mode:'edit'|'read', text, savedAt, demo}}
  // ════════════════════════════════════════════════════════════════════════════════════════
  const RATING = { strength: 'Strength', developing: 'Developing', focus: 'Focus' };
  const RATING_ORDER = { focus: 0, developing: 1, strength: 2 };
  function teacherReportHtml(X, o) {
    o = o || {}; const P = o.P || 'lc'; const T = X.teacher;
    if (!T) return '<p class="lc-empty">No observation report for this class yet.</p>';
    const H = obj(o.header); const F = o.fields || {}; const vals = { ...T.form, ...obj(F.values) }; const R = o.reflection || { mode: 'read', text: '' };
    const kv = (k, v) => `<div><dt>${k}</dt><dd data-no-i18n>${E(v || '—')}</dd></div>`;
    const field = (k, rows) => F.editable
      ? `<label class="lc-sr" for="${P}-f-${k}">${({ evidence: 'Evidence I noticed', worked: 'What worked well', priority: 'Priority area', next: 'Suggested next step' })[k]}</label><textarea id="${P}-f-${k}" data-refl="${k}" rows="${rows}" maxlength="2000">${E(vals[k] || '')}</textarea>`
      : (vals[k] ? `<p class="ins-form-text" id="${P}-f-${k}" data-no-i18n>${E(vals[k])}</p>` : `<p class="ins-form-text" id="${P}-f-${k}"></p>`);
    const ev = T.areas.filter(a => a.evidence).slice().sort((a, b) => (RATING_ORDER[a.rating] ?? 3) - (RATING_ORDER[b.rating] ?? 3)).slice(0, 5);
    const rating = r => RATING[r] ? `<span class="lc-chip lc-rating ${E(r)}">${RATING[r]}</span>` : '';
    const card = (cls, k, icon, label, x) => `<section class="lc-card lc-hfa-card ${cls}"><div class="lc-hfa-k">${icon} <span>${label}</span></div>${x.title ? `<h4 data-no-i18n>${E(x.title)}</h4>` : ''}${x.text ? `<p data-no-i18n>${E(x.text)}</p>` : ''}</section>`;
    return `<section class="lc-card ins-obs-head" aria-labelledby="${P}-obs-h">
        <div class="ins-obs-title"><h3 id="${P}-obs-h">Observation report</h3><span class="lc-chip">TEC Observation Guide</span></div>
        <dl class="ins-kv">
          ${kv('<span>Teacher</span>', H.teacher)}${kv('<span>Group / level</span>', H.group)}${kv('<span>Date</span>', H.date)}
          ${kv('<span>Students present</span>', H.students != null ? String(H.students) : '')}${kv('<span>Class length</span>', H.duration ? H.duration + ' min' : '')}
          <div class="wide"><dt>Class objective</dt><dd data-no-i18n>${E(H.objective || T.objective || '—')}</dd></div>
          <div class="wide"><dt>Observation focus</dt><dd data-no-i18n>${E(H.focus || T.observation_focus || '—')}</dd></div>
        </dl>
      </section>
      ${T.metrics.length ? `<div class="lc-metrics">${T.metrics.map(m => `<div class="lc-metric"><div class="lc-metric-lb">${E(m.label)}</div><div class="lc-metric-v" data-no-i18n>${E(m.value)}</div><div class="lc-metric-x" data-no-i18n>${E(m.sub)}</div></div>`).join('')}</div>` : ''}
      ${o.live ? `<p class="lc-fine lc-live-note">${o.live}</p>` : ''}
      <section class="lc-card ins-step">
        <h3><span class="ins-step-n" aria-hidden="true">1</span> <span>Evidence I noticed</span></h3>
        ${field('evidence', 3)}
        ${ev.length ? `<ul class="ins-evidence">${ev.map(a => `<li><span class="lc-chip ins-tag">${E(a.area)}</span>${rating(a.rating)} <span data-no-i18n>${E(a.evidence)}</span></li>`).join('')}</ul>` : ''}
        <p class="lc-hint">Evidence, not labels: minutes, quotes and counts from the class.</p>
      </section>
      <div class="ins-steps lc-hfa">
        <section class="lc-card ins-step"><h3><span class="ins-step-n" aria-hidden="true">2</span> <span>What worked well</span></h3>
          ${field('worked', 2)}<div class="ins-cards">${T.highlights.slice(0, 2).map(h => card('hl', 'hl', '⭐', 'Highlight', h)).join('')}</div></section>
        <section class="lc-card ins-step"><h3><span class="ins-step-n" aria-hidden="true">3</span> <span>Priority area</span></h3>
          ${field('priority', 2)}<div class="ins-cards">${T.focus.title || T.focus.text ? card('fo', 'fo', '🎯', 'Focus', T.focus) : ''}</div></section>
        <section class="lc-card ins-step"><h3><span class="ins-step-n" aria-hidden="true">4</span> <span>Suggested next step</span></h3>
          ${field('next', 2)}<div class="ins-cards">${T.action.title || T.action.text ? card('ac', 'ac', '🛠️', 'Action', T.action) : ''}</div></section>
      </div>
      ${T.planVsActual.length ? `<section class="lc-card">
        <h3>Plan vs what happened</h3>
        <div class="lc-table-wrap"><table class="lc-table">
          <thead><tr><th scope="col">Activity</th><th scope="col">Planned</th><th scope="col">Actual</th><th scope="col">Difference</th><th scope="col">Note</th></tr></thead>
          <tbody>${T.planVsActual.map(r => { const d = num(r.actual) - num(r.planned); return `<tr><td data-no-i18n>${E(r.section)}</td><td data-no-i18n>${num(r.planned)} min</td><td data-no-i18n>${num(r.actual)} min</td><td><span class="lc-diff ${d > 0 ? 'over' : d < 0 ? 'under' : ''}" data-no-i18n>${d > 0 ? '+' : ''}${d} min</span></td><td data-no-i18n>${E(r.note)}</td></tr>`; }).join('')}</tbody>
        </table></div>
      </section>` : ''}
      ${T.areas.length ? `<section class="lc-card">
        <h3>Classroom observation · 13 areas</h3>
        <p class="lc-hint">Evidence → Impact → Next step. Evidence, not labels: minutes, quotes and counts from the class.</p>
        <div class="lc-areas">${T.areas.map((a, i) => `<details class="lc-area r-${E(a.rating)}" ${a.rating === 'focus' ? 'open' : ''}>
          <summary><span class="lc-area-n" data-no-i18n>${i + 1}</span> <span class="lc-area-name">${E(a.area)}</span> ${rating(a.rating)}</summary>
          <div class="lc-eins">
            <div><div class="lc-eins-k">Evidence</div><p data-no-i18n>${E(a.evidence)}</p></div>
            <div><div class="lc-eins-k">Impact</div><p data-no-i18n>${E(a.impact)}</p></div>
            <div><div class="lc-eins-k">Next step</div><p data-no-i18n>${E(a.next)}</p></div>
          </div></details>`).join('')}</div>
      </section>` : ''}
      <section class="lc-card lc-form ins-reflection">
        <h3><span class="ins-step-n" aria-hidden="true">5</span> <span>Teacher reflection</span></h3>
        ${R.mode === 'edit' ? `<div class="lc-field"><label for="${P}-f-reflection">What would you keep, change or try next time?</label><textarea id="${P}-f-reflection" data-refl="reflection" rows="4" maxlength="8000" placeholder="What would you keep, change or try next time?">${E(R.text || '')}</textarea></div>
        <div class="lc-row"><button type="button" class="lc-btn lc-primary" data-lc="save-reflection" id="${P}-save-reflection">Save reflection</button>${R.savedAt ? ` <span class="lc-fine ins-saved" id="${P}-refl-saved"><span>Saved</span> <span data-no-i18n>${E(fmtWhen(R.savedAt))}</span></span>` : ''}</div>`
        : (R.text ? `<p class="ins-refl-text" id="${P}-refl-text" data-no-i18n>${E(R.text)}</p>` : `<p class="lc-empty" id="${P}-refl-text">The teacher hasn’t written a reflection yet.</p>`)}
        <p class="lc-fine">Private: only the teacher and the institution's admins can see the observation report and the reflection. Never students.</p>
      </section>`;
  }

  // Assistant draft (class language), editable before publishing
  function draftMessage(X, st) {
    const first = firstName(st.name) || (X.lang === 'es' ? 'equipo' : 'there');
    const good = st.didWell[0] || { note: X.lang === 'es' ? 'Participaste con muy buena disposición.' : 'You took part with a great attitude.' };
    const fix = st.improve[0] || { explanation: X.lang === 'es' ? 'Repasá los temas de la clase.' : 'Review the topics of the class.', corrected: '' };
    const lc = s => { s = str(s); return s.charAt(0).toLowerCase() + s.slice(1); };
    if (X.lang === 'es') return `¡Hola ${first}! Muy buen trabajo hoy: ${lc(good.note)} Para la próxima: ${fix.explanation}${fix.corrected ? ` Probá explicarlo así: “${fix.corrected}”.` : ''} ¡Nos vemos en la próxima clase!`;
    return `Hi ${first}! Great work today — ${lc(good.note)} One thing to practise: ${fix.explanation}${fix.corrected ? ` Try saying “${fix.corrected}” a few times this week.` : ''} See you next class!`;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // DEMO PAYLOAD for generate_demo_insights: the sample adapted to the class (subject → sample;
  // 12 varied student profiles; the database assigns them to the enrolled students in name order).
  // ════════════════════════════════════════════════════════════════════════════════════════
  const EXTRA_HIGHLIGHTS = {
    language: ['Used three new linking words in the presentation.', 'Asked for clarification politely and used the answer straight away.',
      'Corrected a mistake without help after a quick hint.', 'Helped the group choose the best plan with clear reasons.',
      'Spoke more than last class and volunteered for the role-play.', 'Great pronunciation of the new vocabulary.',
      'Kept the conversation going with follow-up questions.', 'Summarised the pair’s plan clearly for the class.', 'Took notes and reused them in the final task.'],
    discipline: ['Explicó con sus palabras la idea central de la clase.', 'Propuso una hipótesis y la contrastó con la evidencia.',
      'Corrigió su razonamiento después de una pista breve.', 'Ayudó a su pareja a usar los términos correctos.',
      'Participó más que en la clase anterior.', 'Hizo una pregunta que ordenó la discusión del grupo.',
      'Resolvió el ejercicio de desafío y explicó su estrategia.', 'Usó el vocabulario de la materia con precisión.', 'Conectó el tema con un ejemplo de la vida diaria.'],
  };
  function seeded(n) { let x = (n * 9301 + 49297) % 233280; return () => { x = (x * 9301 + 49297) % 233280; return x / 233280; }; }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;
  function variant(X, i) {
    const base = X.students[i % X.students.length]; const R = seeded(i + 3); const j = () => R() * 2 - 1;
    const p = base.progress; const lang = X.kind === 'language';
    return {
      highlight: i < X.students.length ? base.highlight : EXTRA_HIGHLIGHTS[X.kind][(i - X.students.length) % EXTRA_HIGHLIGHTS[X.kind].length],
      progress: { speakingMin: clamp(r1(p.speakingMin + j() * 2.2), 1, 20), teacherMin: p.teacherMin, vocab: Math.max(3, Math.round(p.vocab + j() * (lang ? 60 : 4))),
        vocabDelta: Math.max(0, Math.round(p.vocabDelta + j() * (lang ? 8 : 2))), level: p.level, levelPrev: i % 3 === 1 ? p.level : p.levelPrev,
        wpm: Math.max(1, Math.round(p.wpm + j() * (lang ? 14 : 1))), wpmDelta: Math.round(j() * (lang ? 6 : 1) + 1),
        score: clamp(Math.round(p.score + j() * 10), 35, 98), scoreDelta: Math.round(j() * 5 + 2) },
      tracker: base.tracker.map(t => ({ ...t, used: Math.max(1, t.used + Math.round(j() * 2)), mastery: clamp(t.mastery + Math.round(j() * 12), 20, 99) })),
      pron: base.pron.map(x => ({ ...x, score: clamp(x.score + Math.round(j() * 10), 30, 99) })),
      didWell: base.didWell, improve: base.improve,
      vocab: base.vocab.slice(i % base.vocab.length).concat(base.vocab.slice(0, i % base.vocab.length)),
    };
  }
  // The sample observation mentions sample students by name: in a real class those names don't exist, so the
  // stored demo report uses neutral wording instead (the students' own names come from their enrollment).
  const NAME_SCRUB = [
    [/Camila did not speak; Valentina spoke 7\.4 min, Mateo 4\.1 min\./g, 'One student did not speak; the most active student spoke 7.4 min, another 4.1 min.'],
    [/Lucas was invited back after being quiet/g, 'a quiet student was invited back into the conversation'],
    [/Camila y Joaquín no intervinieron\./g, 'dos estudiantes no intervinieron.'],
    [/Mateo confundió/g, 'Un estudiante confundió'], [/Sofía terminó/g, 'Una estudiante terminó'],
  ];
  const scrub = v => (typeof v === 'string' ? NAME_SCRUB.reduce((t, [re, r]) => t.replace(re, r), v)
    : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v);
  // ── P-08 (2026-10): demo insights that match THE class ──
  // The fixed samples are a chemistry class and an English class. A class about photosynthesis must not get a report about
  // balancing equations, so: the chemistry / English samples are used only when the class really is chemistry / a
  // language; any other class gets a GENERIC sample built from its own plan (title, objectives, sections, key concepts)
  // or, without a plan, from its title — every text says it is an example.
  function samplesFit(text) {
    const t = String(text || '');
    if (/qu[ií]mic|chem|reacci[oó]n(es)? qu[ií]mic|estequiom|balanceo/i.test(t)) return 'chemistry';
    if (/\b(english|ingl[eé]s|french|franc[eé]s|portugu[eé]s|portuguese|italian|italiano|german|alem[aá]n|esl|efl|ele)\b|\b[ABC][12]\b/i.test(t)) return 'language';
    return null;
  }
  // a saved class (teacher guide) → {title, objectives[], sections[{title, minutes, bullets[]}], concepts[{word, def}]}
  function planOutline(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim());
    const out = { title: (lines[0] || '').replace(/^(semana|week)\s*\S+\s*-\s*(clase|class)\s*\S+\s*-\s*/i, ''), objectives: [], sections: [], concepts: [] };
    let mode = ''; let cur = null;
    const MIN = /(\d{1,3})\s*(?:min(?:utos?|utes?|s)?\.?|['’′])/i;
    for (const l of lines.slice(1)) {
      if (!l) continue;
      const head = l.replace(/^[\p{Extended_Pictographic}\uFE0F⚡⏱]+\s*/u, '');
      if (/^(objetivos|today.s (objectives|goals)|objectives)/i.test(head)) { mode = 'obj'; cur = null; continue; }
      if (/^(conceptos clave|key concepts)/i.test(head)) { mode = 'kc'; cur = null; continue; }
      if (/^(materiales|materials|respuestas|answer key|soluciones|opcional|optional|metodolog|methodology)/i.test(head)) { mode = 'skip'; cur = null; continue; }
      const m = head.match(MIN);
      if (m && head.length <= 100 && !/^[-•*]/.test(head) && !/^⏱/.test(l)) { cur = { title: head, minutes: Math.min(parseInt(m[1], 10) || 10, 240), bullets: [] }; out.sections.push(cur); mode = 'sec'; continue; }
      const b = head.replace(/^[-•*]\s*/, '');
      if (mode === 'obj' && /^[-•*]/.test(head)) out.objectives.push(b);
      else if (mode === 'kc' && /^[-•*]/.test(head)) { const [w, ...d] = b.split(/\s*[:—–]\s+|\s+-\s+/); if (w && w.length <= 60) out.concepts.push({ word: w.trim(), def: d.join(' — ').trim() }); }
      else if (mode === 'sec' && cur && /^[-•*]/.test(head) && cur.bullets.length < 3) cur.bullets.push(b);
    }
    out.objectives = out.objectives.slice(0, 4); out.sections = out.sections.slice(0, 6); out.concepts = out.concepts.slice(0, 6);
    return out;
  }
  function genericSample(o) {
    const es = !(typeof uiLang !== 'undefined' && uiLang === 'en');
    const L = (a, b) => (es ? a : b);
    const P = planOutline(o.plan);
    const title = String(o.title || P.title || L('Clase', 'Class')).slice(0, 160);
    const secs = P.sections.length ? P.sections : [
      { title: L('Inicio', 'Warm-up'), minutes: 10, bullets: [] }, { title: L('Actividad principal', 'Main activity'), minutes: 25, bullets: [] }, { title: L('Cierre', 'Closing'), minutes: 10, bullets: [] }];
    const topics = (P.sections.length ? P.sections : secs).slice(0, 3).map(sct => ({
      title: sct.title.replace(/\s*\(?\d{1,3}\s*(?:min(?:utos?|utes?|s)?\.?|['’′])\)?\s*$/i, '') || sct.title,
      bullets: sct.bullets.length ? sct.bullets.slice(0, 3) : [L('Ejemplo: acá aparece lo que se trabajó en esta parte de la clase.', 'Example: what was worked on in this part of the class appears here.')] }));
    const concepts = P.concepts.length ? P.concepts : topics.map(t => ({ word: t.title.slice(0, 40), def: '' }));
    const objective = P.objectives[0] || L(`Objetivo de la clase «${title}»`, `Objective of the class "${title}"`);
    const ex = L('(ejemplo)', '(example)');
    const student = (k, sc) => ({
      name: '', highlight: L(`Ejemplo: participó con una pregunta sobre «${topics[k % topics.length].title}».`, `Example: asked a question about "${topics[k % topics.length].title}".`),
      progress: { speakingMin: 3 + k, teacherMin: 22, vocab: 6 + 2 * k, vocabDelta: 2 + k, level: L('Explica con apoyo', 'Explains with support'), levelPrev: L('Explica con apoyo', 'Explains with support'), wpm: 2, wpmDelta: 1, score: sc, scoreDelta: 3 },
      tracker: concepts.slice(0, 4).map((c, i) => ({ concept: c.word, difficulty: [L('Básico', 'Basic'), L('Intermedio', 'Intermediate'), L('Avanzado', 'Advanced')][i % 3], used: 2 + ((i + k) % 4), updated: L('Hoy', 'Today'), mastery: 55 + ((i * 13 + k * 7) % 35) })),
      pron: concepts.slice(0, 3).map(c => ({ item: c.word, score: 60 + ((k * 11) % 30), tip: L(`Ejemplo: usó «${c.word}» en una explicación ${ex}.`, `Example: used "${c.word}" in an explanation ${ex}.`) })),
      didWell: [{ text: L(`Ejemplo de algo que dijo en clase sobre «${topics[0].title}».`, `Example of something said in class about "${topics[0].title}".`), note: L('Acá va lo que hizo bien, con su propia frase.', 'What they did well goes here, with their own words.') }],
      improve: [{ original: L('Ejemplo de una idea a revisar.', 'Example of an idea to review.'), corrected: L('Cómo quedaría corregida.', 'How it would read corrected.'), explanation: L('La explicación breve para el estudiante.', 'A short explanation for the student.') }],
      vocab: concepts.slice(0, 4).map(c => ({ word: c.word, pos: L('concepto', 'concept'), level: L('Intermedio', 'Intermediate'), def: c.def || L('Definición según la clase.', 'Definition as given in class.'), quote: '', example: '' })),
    });
    const area = (area, rating) => ({ area, rating, evidence: L('Ejemplo: acá va la evidencia de la clase (minuto, cita, conteo).', 'Example: the evidence from the class goes here (minute, quote, count).'), impact: L('Ejemplo de impacto en los estudiantes.', 'Example of the impact on students.'), next: L('Ejemplo de próximo paso.', 'Example of a next step.') });
    return {
      key: 'generic', kind: 'discipline', lang: es ? 'es' : 'en', title, subject: o.group || title, durationMin: secs.reduce((n, x) => n + (x.minutes || 0), 0) || 45, participants: 8,
      recap: { summary: L(`Así se va a ver el resumen de «${title}» cuando el aula grabe de verdad: qué se trabajó y los conceptos clave. Estos son datos de ejemplo.`,
        `This is how the recap of "${title}" will look once the classroom really records: what was covered and the key concepts. This is sample data.`), topics },
      students: [student(0, 78), student(1, 64), student(2, 88)],
      teacher: {
        objective, observation_focus: L('Participación de los estudiantes', 'Student participation'),
        metrics: [{ label: 'Teacher talk time', value: '48%', sub: L('ejemplo', 'example') }, { label: 'Student talk time', value: '52%', sub: L('meta ≥ 50%', 'target ≥ 50%') },
          { label: 'Questions asked', value: '20', sub: L('ejemplo', 'example') }, { label: 'Average wait time', value: '2,5 s', sub: L('ejemplo', 'example') }],
        highlights: [{ title: L('Ejemplo', 'Example'), text: L(`Acá aparece lo que funcionó en «${topics[0].title}», con evidencia de la grabación.`, `What worked in "${topics[0].title}" appears here, with evidence from the recording.`) }],
        focus: { title: L('Participación', 'Participation'), text: L('Ejemplo de foco de mejora para la próxima clase.', 'Example of a focus for the next class.') },
        action: { title: L('Próxima clase', 'Next class'), text: L('Ejemplo de un paso concreto para la próxima clase.', 'Example of a concrete step for the next class.') },
        areas: [area('Purpose & Alignment', 'strength'), area('STT & Participation', 'developing'), area('Questions & Interaction', 'strength'), area('Pacing & Transitions', 'developing'), area('Evidence of Learning', 'focus')],
        planVsActual: secs.map((x, i) => ({ section: x.title, planned: x.minutes, actual: Math.max(1, x.minutes + [1, 3, -2, 0, 2, -1][i % 6]), note: L('ejemplo', 'example') })),
        form: { evidence: L('Ejemplo de evidencia observada.', 'Example of observed evidence.'), worked: L('Ejemplo de lo que funcionó.', 'Example of what worked.'), priority: L('Participación', 'Participation'), next: L('Ejemplo de próximo paso.', 'Example of a next step.') },
      },
    };
  }
  // {key?, title, group, plan?} → payload. An explicit sample key is kept (the free demo); otherwise the class decides (P-08).
  function buildDemoPayload(o) {
    o = o || {};
    const fit = samplesFit([o.title, o.group, planOutline(o.plan).title].filter(Boolean).join(' '));
    const key = SAMPLES[o.key] ? o.key : fit;
    if (!key) {
      const G = model(genericSample(o)); const T = G.teacher;
      return { kind: G.kind, lang: G.lang, subject: G.subject, title: G.title, duration_min: G.durationMin, recap: G.recap, generic: true,
        teacher: { objective: T.objective, observation_focus: T.observation_focus, metrics: T.metrics, highlights: T.highlights, focus: T.focus, action: T.action, areas: T.areas, planVsActual: T.planVsActual, form: T.form },
        students: Array.from({ length: 12 }, (_, i) => ({ ...variant(G, i), highlight: G.students[i % G.students.length].highlight })) };
    }
    const X = sampleModel(key); const T = X.teacher;
    return {
      kind: X.kind, lang: X.lang, subject: o.group || X.subject, title: o.title || X.title, duration_min: X.durationMin, recap: X.recap,
      teacher: scrub({ objective: T.objective, observation_focus: T.observation_focus, metrics: T.metrics.filter(m => m.label !== 'Students who spoke'),
        highlights: T.highlights, focus: T.focus, action: T.action, areas: T.areas, planVsActual: T.planVsActual, form: T.form }),
      students: Array.from({ length: 12 }, (_, i) => variant(X, i)),
    };
  }

  window.TCInsightsView = {
    DEMO_BANNER, SAMPLES, LABELS, SUBTABS, banner, demoChip, pickSampleKey, initials, colorFor,
    model, sampleModel, modelFromSession, modelFromStudent, planOutline, samplesFit,
    studentPickerHtml, subtabsHtml, studentTabsHtml, teacherReportHtml, draftMessage, buildDemoPayload, fmtWhen,
  };

  // ════════════════════════════════════════════════════════════════════════════════════════
  // SPANISH (rioplatense "vos"); merged into the app dictionary
  // ════════════════════════════════════════════════════════════════════════════════════════
  if (typeof I18N_ES === 'object' && I18N_ES) Object.assign(I18N_ES, {
    [DEMO_BANNER]: 'Datos de demostración: los insights reales se activan cuando se conecte el aula en vivo', 'Demo': 'Demo',
    'Easy': 'Fácil', 'Medium': 'Media', 'Hard': 'Difícil', 'Today': 'Hoy', '2 classes ago': 'Hace 2 clases', 'Básico': 'Básico', 'Intermedio': 'Intermedio', 'Avanzado': 'Avanzado', 'Hoy': 'Hoy',
    'Insights': 'Insights', 'Student insights': 'Insights del estudiante', 'Teacher insights': 'Insights del docente', 'Choose a student': 'Elegí un estudiante',
    'Summary': 'Resumen', 'Overview': 'Resumen', 'Recap': 'Repaso', 'Progress': 'Progreso', 'Feedback': 'Devolución', 'Vocabulary': 'Vocabulario', 'Key terms': 'Términos clave',
    'Message to': 'Mensaje para', 'Message to the student': 'Mensaje para el estudiante', 'PH:Write a personal note for this student…': 'Escribí una nota personal para este estudiante…',
    '✨ Draft with assistant': '✨ Redactar con el asistente', 'Send to student': 'Enviar al estudiante', 'Demo: messages are not sent.': 'Demo: los mensajes no se envían.',
    'Save draft': 'Guardar borrador', 'Publish to student': 'Publicar para el estudiante', 'Publish changes': 'Publicar cambios', 'Published': 'Publicado',
    'the student can see it': 'el estudiante lo puede ver', 'What the student sees:': 'Lo que ve el estudiante:',
    'Draft: the student can’t see it until you publish it.': 'Borrador: el estudiante no lo ve hasta que lo publiques.',
    'You have changes that are not published yet.': 'Tenés cambios que todavía no publicaste.', 'Message published': 'Mensaje publicado',
    'The teacher hasn’t published a message for this student yet.': 'El docente todavía no publicó un mensaje para este estudiante.',
    'Read-only: only the teacher of the group writes these messages.': 'Solo lectura: estos mensajes los escribe el docente del grupo.',
    'Message from your teacher': 'Mensaje de tu docente', 'Your teacher hasn’t sent you a message for this class yet.': 'Tu docente todavía no te mandó un mensaje para esta clase.',
    'Highlight': 'Destacado', 'At a glance': 'De un vistazo', 'of class talk': 'del habla en clase', 'from': 'desde', 'no change': 'sin cambios',
    'Speaking time': 'Tiempo de habla', 'Vocabulary size': 'Vocabulario activo', 'Speaking level (CEFR)': 'Nivel oral (MCER)', 'Words per minute': 'Palabras por minuto', 'Grammar score': 'Puntaje de gramática',
    'Subject terms used': 'Términos de la materia usados', 'Explanation level': 'Nivel de explicación', 'Questions asked': 'Preguntas hechas', 'Concept accuracy': 'Precisión conceptual',
    'Class summary': 'Resumen de la clase', 'Topics covered': 'Temas tratados', 'Grammar tracker': 'Seguimiento de gramática', 'Concept tracker': 'Seguimiento de conceptos',
    'Concept': 'Concepto', 'Difficulty': 'Dificultad', 'Used': 'Usado', 'Updated': 'Actualizado', 'Mastery': 'Dominio',
    'Pronunciation': 'Pronunciación', 'Grammar': 'Gramática', 'Concept use': 'Uso de conceptos', 'Terms and reasoning': 'Términos y razonamiento',
    'What you did well': 'Lo que hiciste bien', 'What you can improve': 'Lo que podés mejorar', 'corrected:': 'corregido:',
    'based on the student’s own microphone track.': 'basado en la pista del micrófono del propio estudiante.',
    'Word': 'Palabra', 'Part of speech': 'Categoría gramatical', 'CEFR': 'MCER', 'Definition': 'Definición', 'From the lesson': 'En la clase', 'Example': 'Ejemplo',
    'Term': 'Término', 'Type': 'Tipo', 'Level': 'Nivel', 'Student': 'Estudiante', 'Teacher': 'Docente', 'Students': 'Estudiantes',
    'No student insights for this class.': 'Esta clase no tiene insights de estudiantes.',
    // teacher report
    'Observation report': 'Informe de observación', 'TEC Observation Guide': 'Guía de observación TEC', 'Group / level': 'Grupo / nivel', 'Date': 'Fecha',
    'Students present': 'Estudiantes presentes', 'Class length': 'Duración de la clase', 'Class objective': 'Objetivo de la clase', 'Observation focus': 'Foco de la observación',
    'Teacher talk time': 'Habla del docente', 'Student talk time': 'Habla de estudiantes', 'Average wait time': 'Tiempo de espera promedio',
    'Students who spoke': 'Estudiantes que hablaron', 'Longest teacher turn': 'Intervención docente más larga',
    'Evidence I noticed': 'Evidencia que noté', 'What worked well': 'Qué funcionó bien', 'Priority area': 'Área prioritaria', 'Suggested next step': 'Próximo paso sugerido',
    'Teacher reflection': 'Reflexión docente', 'Evidence, not labels: minutes, quotes and counts from the class.': 'Evidencia, no etiquetas: minutos, citas y conteos de la clase.',
    'From your demo session:': 'De tu sesión de demo:', 'Focus': 'Foco', 'Action': 'Acción',
    'Plan vs what happened': 'Plan vs. lo que pasó', 'Activity': 'Actividad', 'Planned': 'Planificado', 'Actual': 'Real', 'Difference': 'Diferencia', 'Note': 'Nota',
    'Classroom observation · 13 areas': 'Observación de clase · 13 áreas',
    'Evidence → Impact → Next step. Evidence, not labels: minutes, quotes and counts from the class.': 'Evidencia → Impacto → Próximo paso. Evidencia, no etiquetas: minutos, citas y conteos de la clase.',
    'Strength': 'Fortaleza', 'Developing': 'En desarrollo', 'Evidence': 'Evidencia', 'Impact': 'Impacto', 'Next step': 'Próximo paso',
    'Purpose & Alignment': 'Propósito y alineación', 'Rapport': 'Vínculo', 'STT & Participation': 'Habla estudiantil y participación',
    'Instructions & Task Setup': 'Consignas y armado de tareas', 'Scaffolding': 'Andamiaje', 'Language Input': 'Input de lengua',
    'Monitoring & Feedback': 'Monitoreo y devolución', 'Error Correction': 'Corrección de errores', 'Questions & Interaction': 'Preguntas e interacción',
    'Pacing & Transitions': 'Ritmo y transiciones', 'Materials & Tech': 'Materiales y tecnología', 'Personalization': 'Personalización', 'Evidence of Learning': 'Evidencia de aprendizaje',
    'What would you keep, change or try next time?': '¿Qué mantendrías, cambiarías o probarías la próxima vez?',
    'PH:What would you keep, change or try next time?': '¿Qué mantendrías, cambiarías o probarías la próxima vez?', 'Save reflection': 'Guardar reflexión', 'Saved': 'Guardado',
    'The teacher hasn’t written a reflection yet.': 'El docente todavía no escribió su reflexión.',
    "Private: only the teacher and the institution's admins can see the observation report and the reflection. Never students.": 'Privado: el informe de observación y la reflexión solo los ven el docente y los admins de la institución. Nunca los estudiantes.',
    'No observation report for this class yet.': 'Esta clase todavía no tiene informe de observación.',
  });
})();
