// TeroClass — plans, free trial and "Hablar con ventas" (2026-10-21). Shared by the app (public/index.html) and the
// public plans page (/planes · /plans → public/planes.html). Vanilla JS, no build step.
// · Plans and prices come from the database (get_plans: public, also without a session); the texts are here, in Spanish
//   (rioplatense "vos") and English. Prices in the texts are always built from the data (the super admin edits them).
// · Free trial UI (the limit itself is enforced by the server: consume_ai_quota → /api/generate 402 'trial_limit'):
//   persistent banner "Te quedan N clases de prueba", the pop-up after the 2nd completed class (once), the reminder after the
//   4th (once), the plans pop-up when the 6th is refused, the PDF watermark. Students and the super admin never see any of it.
// · "Hablar con ventas" form → POST /api/notify/lead (with the session when there is one; without one only when the server
//   has Turnstile configured). "Quiero el plan Docente" opens the same form preselected: there is no online payment yet.
// Containers are data-no-i18n: the app's translator leaves them alone and they re-render on a language change.
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Same structure as platform_settings.plans (001_base.sql seed) — used only if get_plans can't be read.
  const FALLBACK = { version: '2026-10-21', credit_tokens: 25000,
    trial: { generations_lifetime: 5, paywall_at: 2, reminder_at: 4, pdf_watermark: true, video_trial_minutes: 40, video_max_participants: 4 },
    plans: [
      { id: 'trial', prices: { usd: { monthly: 0, annual: 0 }, eur: { monthly: 0, annual: 0 } }, limits: { generations_lifetime: 5 } },
      { id: 'docente', prices: { usd: { monthly: 12, annual: 99 }, eur: { monthly: 11.99, annual: 99, vat_included: true } }, limits: { generations_per_month: 25, video_hours_per_month: 1, methodologies_max: 5 } },
      { id: 'institucion', tiers: [
          { seats_from: 3, seats_to: 9, usd: { monthly: 17, annual_per_month: 14 }, eur: { monthly: 17, annual_per_month: 14 } },
          { seats_from: 10, seats_to: 29, usd: { monthly: 14.5, annual_per_month: 12 }, eur: { monthly: 14.5, annual_per_month: 12 } },
          { seats_from: 30, seats_to: 99, usd: { monthly: 12, annual_per_month: 10 }, eur: { monthly: 12, annual_per_month: 10 } }],
        limits: { generations_per_seat_month: 30, video_hours_per_seat_month: 5, insights_classes_per_seat_month: 1, video_max_participants: 30 } },
      { id: 'institucion_plus', prices: { usd: { reference_per_seat_month_annual: 9 }, eur: { reference_per_seat_month_annual: 9 } }, limits: { seats_min: 100 } }],
    addons: [
      { id: 'pack_clases_50', kind: 'classes', credits: 50, usd: 25, eur: 22 }, { id: 'pack_clases_200', kind: 'classes', credits: 200, usd: 85, eur: 76 },
      { id: 'pack_analizadas_10', kind: 'analyzed', credits: 10, usd: 25, eur: 22 }, { id: 'pack_analizadas_50', kind: 'analyzed', credits: 50, usd: 110, eur: 98 },
      { id: 'seguimiento_ia_alumno', kind: 'tracking', credits: 8, usd: 2, eur: 1.8 }, { id: 'pack_aula_20h', kind: 'video', credits: 20, usd: 49, eur: 44 }],
    launch_offers: [], founder_taken: 0 };

  const T = {
    es: {
      title: 'Planes de TeroClass', subtitle: 'Clases listas para dar, adaptadas a tu metodología. Pagás por docente; tus alumnos son gratis.',
      monthly: 'Mensual', annual: 'Anual', save_up_to: 'ahorrá hasta {pct}%', billing: 'Facturación', currency: 'Moneda', cur_usd: 'USD', cur_eur: 'EUR (España / UE)',
      back_app: '← Volver a TeroClass', sign_in: 'Ingresar', lang_label: 'Idioma',
      per_month: '/mes', per_year: '/año', per_teacher_month: 'por docente/mes', vat_incl: 'IVA incluido', plus_vat: '+ IVA',
      trial_title: 'Prueba gratis', trial_b1: '{n} clases completas', trial_b2: 'PDF con marca de agua', trial_b3: '1 aula de prueba de {m} min', trial_b4: 'Sin tarjeta',
      trial_cta: 'Empezar gratis', trial_cta_in: 'Ir a TeroClass',
      doc_title: 'Docente', doc_annual_eq: '≈ {m} por mes · ahorrás {pct}%', doc_or_annual: 'o {a} (ahorrás {pct}%)',
      doc_b1: '{n} clases por mes', doc_b2: 'PDF sin marca de agua', doc_b3: '{n} metodologías propias', doc_b4: '{h} h de aula virtual por mes', doc_b5: 'Packs extra cuando los necesites',
      doc_cta: 'Quiero el plan Docente', doc_note: 'El pago online llega pronto: te contactamos para activarlo.',
      inst_badge: 'Para colegios e institutos', inst_title: 'Institución', inst_from: 'desde {p} por docente/mes', inst_from_annual: 'con pago anual', inst_from_monthly: 'con pago mensual',
      inst_b1: '{n} clases por docente al mes, compartidas', inst_b2: '{h} h de aula virtual por docente', inst_b3: '{n} clase analizada por IA por docente',
      inst_b4: 'Sedes, cátedras y grupos', inst_b5: 'Alumnos ilimitados y gratis', inst_b6: 'Asistencia automática', inst_b7: 'Panel de consumo', inst_b8: 'Pago por transferencia con factura',
      plus_title: 'Institución+', plus_price: 'A medida', plus_ref: 'Referencia: desde {p} por docente/mes con pago anual, más onboarding.',
      plus_b1: 'Más de 100 docentes o redes de colegios', plus_b2: 'Onboarding y carga de tu metodología', plus_b3: 'SSO con Google o Microsoft (próximamente)', plus_b4: 'Contrato y factura', plus_b5: 'Soporte prioritario',
      talk_sales: 'Hablar con ventas',
      tiers_title: 'Institución: precio por docente por mes', tiers_teachers: 'Docentes', tiers_annual: 'Pago anual', tiers_monthly: 'Pago mensual', tiers_plus: '100 o más', tiers_plus_v: 'Institución+ (a medida)',
      tiers_note: 'El tramo vale para todos los docentes de la institución (mínimo 3). Admins cuentan como docentes; los alumnos no pagan.',
      addons_title: 'Extras', addon_pack_clases_50: 'Pack 50 clases', addon_pack_clases_200: 'Pack 200 clases', addon_pack_analizadas_10: 'Pack 10 clases analizadas',
      addon_pack_analizadas_50: 'Pack 50 clases analizadas', addon_seguimiento_ia_alumno: 'Seguimiento IA', addon_seguimiento_ia_alumno_unit: 'por alumno/mes', addon_pack_aula_20h: 'Pack 20 h de aula',
      offers_title: 'Ofertas de lanzamiento',
      offer_founder: 'Instituciones Fundadoras: {d}% menos el primer año con plan anual, precio congelado {m} meses y onboarding gratis. Para las primeras {n} instituciones.',
      offer_founder_left: 'Quedan {n} lugares.', offer_founder_full: 'Ya no quedan lugares.',
      offer_pilot_60d: 'Piloto de {d} días: {p} por hasta {n} docentes, con los límites del plan Institución. Si después contratan el plan anual, se descuenta el 100%.',
      offer_pilot_anii: 'Piloto ANII de {m} meses: hasta {n} docentes y {a} clases analizadas, facturado como servicios técnicos (de {p1} a {p2}).',
      offer_trial_email_coupon: 'Código {code}: {d}% menos el primer año del plan Docente anual. Mencionalo cuando te contactemos.',
      faq_title: 'Preguntas frecuentes',
      faq: [
        ['¿Qué es una "clase"?', 'Una clase completa: guía docente y material del alumno, verificados. Regenerar una parte consume solo una fracción.'],
        ['¿Los alumnos pagan?', 'No. Solo pagan los asientos de docentes y admins. Los alumnos entran gratis y sin límite.'],
        ['¿Qué es una hora de aula?', 'Una hora de sala de video en vivo dentro de TeroClass. Se descuenta por minuto real de uso, no por clase agendada.'],
        ['¿Puedo pagar por transferencia?', 'Sí, en los planes de Institución, con factura. El pago online del plan Docente llega pronto: mientras tanto te lo activamos a mano.'],
        ['¿Qué pasa si me quedo sin clases?', 'Te avisamos al 80%. Al 100% podés sumar un pack o esperar al mes siguiente. Lo que ya creaste siempre se puede ver y exportar.'],
        ['¿Mis datos y los de mis alumnos?', 'Solo tu institución ve los emails de alumnos que carga. No usamos tus clases para entrenar modelos.']],
      foot: 'Todavía no hay pago online: elegí un plan y te contactamos para activarlo. Precios en {cur}{vat}.', foot_vat_eur: ' (Docente con IVA incluido; Institución + IVA)',
      // pop-ups
      gen2_title: '¡Ya generaste {used} clases con TeroClass! 🎉',
      gen2_body: 'Te quedan {remaining} clases de prueba. Pasate a un plan para seguir creando clases listas para dar, con tu metodología, sin marca de agua y con aula virtual.',
      gen2_body_one: 'Te queda 1 clase de prueba. Pasate a un plan para seguir creando clases listas para dar, con tu metodología, sin marca de agua y con aula virtual.',
      inst_np_title: 'Tu institución todavía no tiene un plan activo', inst_np_body: 'Te quedan {remaining} clases de prueba. Avisale a tu admin para activar TeroClass para todo el equipo.',
      notify_admin: 'Avisarle a mi admin', notify_admin_msg: 'Hola, estoy probando TeroClass para planificar clases y me gustaría que lo activemos para todo el equipo. Planes: {url}',
      notify_admin_done: 'Mensaje copiado: pegáselo a tu admin por WhatsApp o email.', notify_admin_fail: 'Copiá este mensaje y mandáselo a tu admin:',
      gen4_title: 'Te queda {remaining} clase de prueba', gen4_title_many: 'Te quedan {remaining} clases de prueba', gen4_body: 'Elegí un plan para no cortar tu ritmo.', see_plans: 'Ver planes', later: 'Más tarde',
      limit_title: 'Usaste tus {limit} clases de prueba', limit_body: 'Todo lo que creaste sigue acá: podés verlo y exportarlo. Para generar clases nuevas, elegí un plan.',
      choose_docente: 'Elegir plan Docente', keep_trying: 'Seguir probando', close: 'Cerrar', questions: '¿Dudas?', contact_us: 'Contactanos', all_plans: 'Ver todos los planes',
      // banner
      banner_many: 'Te quedan {n} clases de prueba', banner_one: 'Te queda 1 clase de prueba', banner_zero: 'Usaste tus {limit} clases de prueba', banner_zero_sub: 'lo que creaste sigue acá',
      banner_plans: 'Ver planes',
      watermark: 'Creado con TeroClass — versión de prueba',
      // sales form
      f_title: 'Hablar con ventas', f_sub: 'Contanos de tu institución y te respondemos en menos de 24 horas hábiles.',
      f_name: 'Nombre y apellido', f_institution: 'Institución', f_role: 'Tu rol', f_country: 'País', f_teachers: '¿Cuántos docentes?', f_channel: '¿Cómo te contactamos?',
      f_whatsapp: 'WhatsApp (con código de país)', f_email: 'Email', f_plan: 'Plan que te interesa', f_message: 'Contanos qué necesitás (opcional)',
      f_consent: 'Acepto que TeroClass me contacte sobre este pedido', f_send: 'Enviar', f_cancel: 'Cancelar', f_sending: 'Enviando…', f_choose: 'Elegí una opción',
      r_direccion: 'Dirección', r_coordinacion: 'Coordinación académica', r_docente: 'Docente', r_administracion: 'Administración', r_otro: 'Otro',
      p_docente: 'Docente (individual)', p_institucion: 'Institución', p_institucion_plus: 'Institución+', p_unsure: 'Todavía no sé',
      c_whatsapp: 'WhatsApp', c_email: 'Email', ph_whatsapp: '+598 99 123 456',
      e_required: 'Completá este campo.', e_email: 'Revisá el email.', e_whatsapp: 'Usá el formato internacional, por ejemplo +598 99 123 456.', e_consent: 'Necesitamos tu permiso para contactarte.',
      e_rate: 'Mandaste varios pedidos seguidos. Probá de nuevo en un rato.', e_captcha: 'Completá la verificación de seguridad.', e_generic: 'No pudimos enviar el pedido. Probá de nuevo.',
      e_auth: 'Para escribirnos, ingresá o creá una cuenta gratis.', e_viewas: 'El modo "Ver como" es solo lectura.',
      ok_title: '¡Listo!', ok_body: '¡Gracias, {name}! Te escribimos en menos de 24 horas hábiles para coordinar una demo de 20 minutos.',
      ok_body_docente: '¡Gracias, {name}! Te escribimos en menos de 24 horas hábiles para activar tu plan Docente.',
      captcha_label: 'Verificación de seguridad',
      countries: { UY: 'Uruguay', AR: 'Argentina', CL: 'Chile', MX: 'México', CO: 'Colombia', PE: 'Perú', EC: 'Ecuador', PY: 'Paraguay', BO: 'Bolivia', BR: 'Brasil',
        ES: 'España', US: 'Estados Unidos', CR: 'Costa Rica', PA: 'Panamá', GT: 'Guatemala', DO: 'República Dominicana', SV: 'El Salvador', HN: 'Honduras', VE: 'Venezuela', ZZ: 'Otro país' },
      loading: 'Cargando planes…',
    },
    en: {
      title: 'TeroClass plans', subtitle: 'Ready-to-teach classes adapted to your methodology. Pay per teacher; students are free.',
      monthly: 'Monthly', annual: 'Yearly', save_up_to: 'save up to {pct}%', billing: 'Billing', currency: 'Currency', cur_usd: 'USD', cur_eur: 'EUR (Spain / EU)',
      back_app: '← Back to TeroClass', sign_in: 'Sign in', lang_label: 'Language',
      per_month: '/month', per_year: '/year', per_teacher_month: 'per teacher/month', vat_incl: 'VAT included', plus_vat: '+ VAT',
      trial_title: 'Free trial', trial_b1: '{n} complete classes', trial_b2: 'Watermarked PDF', trial_b3: 'One {m}-min test classroom', trial_b4: 'No card needed',
      trial_cta: 'Start free', trial_cta_in: 'Go to TeroClass',
      doc_title: 'Teacher', doc_annual_eq: '≈ {m} per month · save {pct}%', doc_or_annual: 'or {a} (save {pct}%)',
      doc_b1: '{n} classes per month', doc_b2: 'Watermark-free PDF', doc_b3: '{n} custom methodologies', doc_b4: '{h} h virtual classroom per month', doc_b5: 'Extra packs when you need them',
      doc_cta: 'I want the Teacher plan', doc_note: 'Online payment is coming soon: we\'ll contact you to activate it.',
      inst_badge: 'For schools and institutes', inst_title: 'Institution', inst_from: 'from {p} per teacher/month', inst_from_annual: 'billed yearly', inst_from_monthly: 'billed monthly',
      inst_b1: '{n} classes per teacher per month, pooled', inst_b2: '{h} h virtual classroom per teacher', inst_b3: '{n} AI-analyzed class per teacher',
      inst_b4: 'Campuses, departments & groups', inst_b5: 'Unlimited free students', inst_b6: 'Automatic attendance', inst_b7: 'Usage dashboard', inst_b8: 'Pay by bank transfer with invoice',
      plus_title: 'Institution+', plus_price: 'Custom', plus_ref: 'Reference: from {p} per teacher/month billed yearly, plus onboarding.',
      plus_b1: '100+ teachers or school networks', plus_b2: 'Onboarding & methodology setup', plus_b3: 'Google or Microsoft SSO (coming soon)', plus_b4: 'Contract & invoicing', plus_b5: 'Priority support',
      talk_sales: 'Talk to sales',
      tiers_title: 'Institution: price per teacher per month', tiers_teachers: 'Teachers', tiers_annual: 'Billed yearly', tiers_monthly: 'Billed monthly', tiers_plus: '100 or more', tiers_plus_v: 'Institution+ (custom)',
      tiers_note: 'The tier price applies to every teacher of the institution (minimum 3). Admins count as teachers; students are free.',
      addons_title: 'Add-ons', addon_pack_clases_50: '50-class pack', addon_pack_clases_200: '200-class pack', addon_pack_analizadas_10: '10 analyzed classes',
      addon_pack_analizadas_50: '50 analyzed classes', addon_seguimiento_ia_alumno: 'AI tracking', addon_seguimiento_ia_alumno_unit: 'per student/month', addon_pack_aula_20h: '20 h classroom pack',
      offers_title: 'Launch offers',
      offer_founder: 'Founding Institutions: {d}% off the first year on a yearly plan, price locked for {m} months and free onboarding. For the first {n} institutions.',
      offer_founder_left: '{n} places left.', offer_founder_full: 'No places left.',
      offer_pilot_60d: '{d}-day pilot: {p} for up to {n} teachers, with the Institution plan limits. If you then sign the yearly plan, 100% is credited.',
      offer_pilot_anii: '{m}-month ANII pilot: up to {n} teachers and {a} analyzed classes, invoiced as technical services ({p1} to {p2}).',
      offer_trial_email_coupon: 'Code {code}: {d}% off the first year of the yearly Teacher plan. Mention it when we contact you.',
      faq_title: 'Frequently asked questions',
      faq: [
        ['What is a "class"?', 'One complete class: teacher guide plus student handout, verified. Regenerating a part uses only a fraction.'],
        ['Do students pay?', 'No. Only teacher and admin seats are paid. Students join free and without limits.'],
        ['What is a classroom hour?', 'One hour of live video room inside TeroClass. It is counted by the minutes actually used, not per scheduled class.'],
        ['Can I pay by bank transfer?', 'Yes, on Institution plans, with an invoice. Online payment for the Teacher plan is coming soon: meanwhile we activate it by hand.'],
        ['What happens if I run out of classes?', 'We alert you at 80%. At 100% you can add a pack or wait for next month. What you already created can always be viewed and exported.'],
        ['What about my data and my students\' data?', 'Only your institution sees the student emails it uploads. We don\'t use your classes to train models.']],
      foot: 'There is no online payment yet: choose a plan and we\'ll contact you to activate it. Prices in {cur}{vat}.', foot_vat_eur: ' (Teacher VAT included; Institution + VAT)',
      gen2_title: 'You\'ve created {used} classes with TeroClass! 🎉',
      gen2_body: 'You have {remaining} trial classes left. Upgrade to keep creating ready-to-teach classes in your methodology, without watermark and with a virtual classroom.',
      gen2_body_one: 'You have 1 trial class left. Upgrade to keep creating ready-to-teach classes in your methodology, without watermark and with a virtual classroom.',
      inst_np_title: 'Your institution doesn\'t have an active plan yet', inst_np_body: 'You have {remaining} trial classes left. Let your admin know so they can activate TeroClass for the whole team.',
      notify_admin: 'Notify my admin', notify_admin_msg: 'Hi! I\'m trying TeroClass to plan classes and I\'d like us to activate it for the whole team. Plans: {url}',
      notify_admin_done: 'Message copied: paste it to your admin on WhatsApp or by email.', notify_admin_fail: 'Copy this message and send it to your admin:',
      gen4_title: 'You have {remaining} trial class left', gen4_title_many: 'You have {remaining} trial classes left', gen4_body: 'Pick a plan to keep going.', see_plans: 'See plans', later: 'Later',
      limit_title: 'You\'ve used your {limit} trial classes', limit_body: 'Everything you created is still here to view and export. To create new classes, choose a plan.',
      choose_docente: 'Choose Teacher plan', keep_trying: 'Keep trying', close: 'Close', questions: 'Questions?', contact_us: 'Contact us', all_plans: 'See all plans',
      banner_many: '{n} trial classes left', banner_one: '1 trial class left', banner_zero: 'You\'ve used your {limit} trial classes', banner_zero_sub: 'what you created is still here',
      banner_plans: 'See plans',
      watermark: 'Created with TeroClass — trial version',
      f_title: 'Talk to sales', f_sub: 'Tell us about your institution and we\'ll get back to you within 1 business day.',
      f_name: 'Full name', f_institution: 'Institution', f_role: 'Your role', f_country: 'Country', f_teachers: 'How many teachers?', f_channel: 'How should we reach you?',
      f_whatsapp: 'WhatsApp (with country code)', f_email: 'Email', f_plan: 'Plan you\'re interested in', f_message: 'Tell us what you need (optional)',
      f_consent: 'I agree to be contacted about this request', f_send: 'Send', f_cancel: 'Cancel', f_sending: 'Sending…', f_choose: 'Choose an option',
      r_direccion: 'Leadership', r_coordinacion: 'Academic coordination', r_docente: 'Teacher', r_administracion: 'Administration', r_otro: 'Other',
      p_docente: 'Teacher (individual)', p_institucion: 'Institution', p_institucion_plus: 'Institution+', p_unsure: 'Not sure yet',
      c_whatsapp: 'WhatsApp', c_email: 'Email', ph_whatsapp: '+1 555 123 4567',
      e_required: 'Please fill in this field.', e_email: 'Please check the email.', e_whatsapp: 'Use the international format, e.g. +598 99 123 456.', e_consent: 'We need your permission to contact you.',
      e_rate: 'You sent several requests in a row. Please try again in a while.', e_captcha: 'Please complete the security check.', e_generic: 'We couldn\'t send your request. Please try again.',
      e_auth: 'To contact us, sign in or create a free account.', e_viewas: '"View as" is read-only.',
      ok_title: 'Done!', ok_body: 'Thanks, {name}! We\'ll reach out within 1 business day to set up a 20-minute demo.',
      ok_body_docente: 'Thanks, {name}! We\'ll reach out within 1 business day to activate your Teacher plan.',
      captcha_label: 'Security check',
      countries: { UY: 'Uruguay', AR: 'Argentina', CL: 'Chile', MX: 'Mexico', CO: 'Colombia', PE: 'Peru', EC: 'Ecuador', PY: 'Paraguay', BO: 'Bolivia', BR: 'Brazil',
        ES: 'Spain', US: 'United States', CR: 'Costa Rica', PA: 'Panama', GT: 'Guatemala', DO: 'Dominican Republic', SV: 'El Salvador', HN: 'Honduras', VE: 'Venezuela', ZZ: 'Other country' },
      loading: 'Loading plans…',
    },
  };
  const COUNTRIES = ['UY', 'AR', 'CL', 'MX', 'CO', 'PE', 'EC', 'PY', 'BO', 'BR', 'ES', 'US', 'CR', 'PA', 'GT', 'DO', 'SV', 'HN', 'VE', 'ZZ'];
  const EU = /^(es|ca|eu|gl)-ES$|-(AT|BE|BG|HR|CY|CZ|DE|DK|EE|FI|FR|GR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)$/i;

  const S = { plans: null, loading: null, lang: 'es', cur: 'USD', period: 'annual', trial: null, ctx: null, cfg: null, popup: null, popupTimer: null,
    form: null, lastFocus: null, page: false };

  function lang() { const l = S.ctx?.lang?.() || S.lang; return l === 'en' ? 'en' : 'es'; }
  function t(k, vars) {
    const L = T[lang()]; let s = L[k] ?? T.es[k] ?? k;
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, v) => (vars[v] ?? m));
    return s;
  }
  function locale() { return lang() === 'en' ? 'en-US' : 'es-UY'; }
  // "USD 12", "USD 14,50" / "12 €", "11,99 €"
  function money(n, cur = S.cur) {
    const v = Number(n) || 0; const int = Math.abs(v - Math.round(v)) < 1e-9;
    const num = v.toLocaleString(cur === 'EUR' ? (lang() === 'en' ? 'en-IE' : 'es-ES') : locale(), { minimumFractionDigits: int ? 0 : 2, maximumFractionDigits: 2 });
    return cur === 'EUR' ? (lang() === 'en' ? '€' + num : num + ' €') : 'USD ' + num;
  }
  const key = () => (S.cur === 'EUR' ? 'eur' : 'usd');
  const plan = id => (S.plans?.plans || []).find(p => p.id === id) || FALLBACK.plans.find(p => p.id === id) || {};
  const pct = (part, whole) => (whole > 0 ? Math.round((1 - part / whole) * 100) : 0);
  function docSaving() { const p = plan('docente').prices?.[key()] || {}; return pct(Number(p.annual) || 0, (Number(p.monthly) || 0) * 12); }
  function maxSaving() {
    let m = docSaving();
    for (const tr of plan('institucion').tiers || []) { const x = tr[key()] || {}; m = Math.max(m, pct(Number(x.annual_per_month) || 0, Number(x.monthly) || 0)); }
    return m;
  }
  function instFrom(period = S.period) {
    const tiers = plan('institucion').tiers || []; const f = period === 'annual' ? 'annual_per_month' : 'monthly';
    const vals = tiers.map(x => Number(x[key()]?.[f])).filter(Number.isFinite);
    return vals.length ? Math.min(...vals) : 0;
  }
  function trialCfg() { return { ...FALLBACK.trial, ...(S.plans?.trial || {}) }; }

  async function loadPlans(force) {
    if (S.plans && !force) return S.plans;
    if (S.loading && !force) return S.loading;
    const sb = S.ctx?.sb || window.__tcPlansSb;
    S.loading = (async () => {
      try {
        if (!sb) throw new Error('no client');
        const { data, error } = await sb.rpc('get_plans');
        const d = typeof data === 'string' ? JSON.parse(data) : data;
        if (error || !d || !Array.isArray(d.plans)) throw new Error('no plans');
        S.plans = d;
      } catch (e) { S.plans = S.plans || FALLBACK; }
      S.loading = null; return S.plans;
    })();
    return S.loading;
  }

  // ── plan cards (pop-up and page) ──
  function bullets(list) { return `<ul class="tp-bullets">${list.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`; }
  function cardTrial(loggedIn) {
    const tc = trialCfg();
    return `<article class="tp-card" data-plan="trial"><h3>${esc(t('trial_title'))}</h3><div class="tp-price"><span class="tp-amount">${esc(money(0))}</span></div>
      ${bullets([t('trial_b1', { n: tc.generations_lifetime }), t('trial_b2'), t('trial_b3', { m: tc.video_trial_minutes || 40 }), t('trial_b4')])}
      <a class="tp-btn ghost" href="/" data-tp="start">${esc(loggedIn ? t('trial_cta_in') : t('trial_cta'))}</a></article>`;
  }
  function cardDocente(compact) {
    const p = plan('docente'); const pr = p.prices?.[key()] || {}; const L = p.limits || {};
    const annual = S.period === 'annual' || compact;
    const amount = compact ? `${money(pr.monthly)}${t('per_month')}` : annual ? `${money(pr.annual)}${t('per_year')}` : `${money(pr.monthly)}${t('per_month')}`;
    const sub = compact ? t('doc_or_annual', { a: money(pr.annual) + t('per_year'), pct: docSaving() })
      : annual ? t('doc_annual_eq', { m: money(Math.round((pr.annual / 12) * 100) / 100), pct: docSaving() }) : '';
    const vat = S.cur === 'EUR' && pr.vat_included ? `<div class="tp-vat">${esc(t('vat_incl'))}</div>` : '';
    const list = compact ? [t('doc_b1', { n: L.generations_per_month ?? 25 }), t('doc_b2'), t('doc_b4', { h: L.video_hours_per_month ?? 1 })]
      : [t('doc_b1', { n: L.generations_per_month ?? 25 }), t('doc_b2'), t('doc_b3', { n: L.methodologies_max ?? 5 }), t('doc_b4', { h: L.video_hours_per_month ?? 1 }), t('doc_b5')];
    return `<article class="tp-card" data-plan="docente"><h3>${esc(t('doc_title'))}</h3>
      <div class="tp-price"><span class="tp-amount">${esc(amount)}</span>${sub ? `<span class="tp-sub">${esc(sub)}</span>` : ''}</div>${vat}
      ${bullets(list)}<button type="button" class="tp-btn" data-tp="docente">${esc(t('doc_cta'))}</button><p class="tp-note">${esc(t('doc_note'))}</p></article>`;
  }
  function cardInst(compact) {
    const p = plan('institucion'); const L = p.limits || {};
    const per = compact ? 'annual' : S.period;
    const vat = S.cur === 'EUR' ? ` · ${t('plus_vat')}` : '';
    const list = [t('inst_b1', { n: L.generations_per_seat_month ?? 30 }), t('inst_b2', { h: L.video_hours_per_seat_month ?? 5 }), t('inst_b3', { n: L.insights_classes_per_seat_month ?? 1 }),
      t('inst_b4'), t('inst_b5'), t('inst_b6'), t('inst_b7'), t('inst_b8')];
    return `<article class="tp-card featured" data-plan="institucion"><span class="tp-badge">${esc(t('inst_badge'))}</span><h3>${esc(t('inst_title'))}</h3>
      <div class="tp-price"><span class="tp-amount">${esc(t('inst_from', { p: money(instFrom(per)) }))}</span><span class="tp-sub">${esc(t(per === 'annual' ? 'inst_from_annual' : 'inst_from_monthly') + vat)}</span></div>
      ${bullets(compact ? list.slice(0, 5) : list)}<button type="button" class="tp-btn" data-tp="sales" data-plan-pick="institucion">${esc(t('talk_sales'))}</button></article>`;
  }
  function cardPlus(compact) {
    const p = plan('institucion_plus'); const ref = p.prices?.[key()]?.reference_per_seat_month_annual;
    const list = compact ? [t('plus_b1'), t('plus_b2'), t('plus_b4')] : [t('plus_b1'), t('plus_b2'), t('plus_b3'), t('plus_b4'), t('plus_b5')];
    return `<article class="tp-card" data-plan="institucion_plus"><h3>${esc(t('plus_title'))}</h3><div class="tp-price"><span class="tp-amount">${esc(t('plus_price'))}</span>
      ${ref && !compact ? `<span class="tp-sub">${esc(t('plus_ref', { p: money(ref) }))}</span>` : ''}</div>
      ${bullets(list)}<button type="button" class="tp-btn ghost" data-tp="sales" data-plan-pick="institucion_plus">${esc(t('talk_sales'))}</button></article>`;
  }

  // ── the public / in-app plans page ──
  function tiersTable() {
    const tiers = plan('institucion').tiers || []; const vat = S.cur === 'EUR' ? ` ${t('plus_vat')}` : '';
    const rows = tiers.map(x => `<tr${S.period === 'annual' ? ' class="tp-annual"' : ''}><th scope="row">${esc(x.seats_from)}–${esc(x.seats_to)}</th>
      <td>${esc(money(x[key()]?.annual_per_month))}${esc(vat)}</td><td>${esc(money(x[key()]?.monthly))}${esc(vat)}</td></tr>`).join('');
    return `<section class="tp-section" aria-labelledby="tp-tiers-h"><h2 id="tp-tiers-h">${esc(t('tiers_title'))}</h2>
      <div class="tp-table-wrap"><table class="tp-tiers"><thead><tr><th scope="col">${esc(t('tiers_teachers'))}</th><th scope="col"${S.period === 'annual' ? ' class="on"' : ''}>${esc(t('tiers_annual'))}</th><th scope="col"${S.period === 'monthly' ? ' class="on"' : ''}>${esc(t('tiers_monthly'))}</th></tr></thead>
      <tbody>${rows}<tr><th scope="row">${esc(t('tiers_plus'))}</th><td colspan="2">${esc(t('tiers_plus_v'))}</td></tr></tbody></table></div>
      <p class="tp-small">${esc(t('tiers_note'))}</p></section>`;
  }
  function addonsHtml() {
    const items = (S.plans?.addons || []).filter(a => ['classes', 'analyzed', 'tracking', 'video'].includes(a.kind)).map(a => {
      const name = T[lang()]['addon_' + a.id] || a['name_' + lang()] || a.id; const unit = a.kind === 'tracking' ? ' ' + t('addon_seguimiento_ia_alumno_unit') : '';
      return `<li><span>${esc(name)}</span> <b>${esc(money(a[key()]) + unit)}</b></li>`;
    }).join('');
    return items ? `<section class="tp-section" aria-labelledby="tp-addons-h"><h2 id="tp-addons-h">${esc(t('addons_title'))}</h2><ul class="tp-addons">${items}</ul></section>` : '';
  }
  function offersHtml() {
    const offers = (S.plans?.launch_offers || []).filter(o => o.enabled);
    if (!offers.length) return '';
    const li = offers.map(o => {
      let s = '';
      if (o.id === 'founder') {
        s = t('offer_founder', { d: o.discount_pct_year1, m: o.price_lock_months, n: o.max_accounts });
        const left = Math.max((Number(o.max_accounts) || 0) - (Number(S.plans.founder_taken) || 0), 0);
        if (Number(S.plans.founder_taken) > 0) s += ' ' + (left > 0 ? t('offer_founder_left', { n: left }) : t('offer_founder_full')); // only real numbers, never invented scarcity
      } else if (o.id === 'pilot_60d') s = t('offer_pilot_60d', { d: o.duration_days, p: money(o.price_usd, 'USD'), n: o.max_seats });
      else if (o.id === 'pilot_anii') s = t('offer_pilot_anii', { m: o.duration_months, n: o.max_seats, a: o.analyzed_classes_included, p1: money(o.price_usd_min, 'USD'), p2: money(o.price_usd_max, 'USD') });
      else if (o.id === 'trial_email_coupon') s = t('offer_trial_email_coupon', { code: o.code, d: o.discount_pct_year1 });
      else return '';
      return `<li data-offer="${esc(o.id)}">${esc(s)}</li>`;
    }).join('');
    return `<section class="tp-section tp-offers" aria-labelledby="tp-offers-h"><h2 id="tp-offers-h">${esc(t('offers_title'))}</h2><ul>${li}</ul></section>`;
  }
  function faqHtml() {
    return `<section class="tp-section" aria-labelledby="tp-faq-h"><h2 id="tp-faq-h">${esc(t('faq_title'))}</h2>
      ${T[lang()].faq.map(([q, a]) => `<details class="tp-faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>`;
  }
  function seg(name, options, current, label) {
    return `<div class="tp-seg" role="group" aria-label="${esc(label)}">${options.map(([v, l]) => `<button type="button" data-tp-${name}="${esc(v)}" aria-pressed="${v === current}">${esc(l)}</button>`).join('')}</div>`;
  }
  function pageHtml(loggedIn) {
    const vatNote = S.cur === 'EUR' ? t('foot_vat_eur') : '';
    return `<header class="tp-head"><h1>${esc(t('title'))}</h1><p class="tp-lead">${esc(t('subtitle'))}</p>
      <div class="tp-controls">${seg('period', [['monthly', t('monthly')], ['annual', `${t('annual')} (${t('save_up_to', { pct: maxSaving() })})`]], S.period, t('billing'))}
      ${seg('cur', [['USD', t('cur_usd')], ['EUR', t('cur_eur')]], S.cur, t('currency'))}</div></header>
      <div class="tp-grid">${cardTrial(loggedIn)}${cardDocente(false)}${cardInst(false)}${cardPlus(false)}</div>
      ${tiersTable()}${addonsHtml()}${offersHtml()}${faqHtml()}
      <p class="tp-foot">${esc(t('foot', { cur: S.cur, vat: vatNote }))}</p>`;
  }

  // ── modal helpers (pop-up + sales form share one overlay) ──
  function overlay() {
    let o = document.getElementById('tp-overlay');
    if (!o) {
      o = document.createElement('div'); o.id = 'tp-overlay'; o.className = 'tp-overlay'; o.setAttribute('data-no-i18n', ''); o.hidden = true;
      o.innerHTML = '<div class="tp-modal" role="dialog" aria-modal="true" aria-labelledby="tp-modal-title" tabindex="-1"></div>';
      document.body.appendChild(o);
      o.addEventListener('click', e => { if (e.target === o) closeModal(); });
    }
    return o;
  }
  function openModal(html, kind) {
    const o = overlay(); const m = o.querySelector('.tp-modal');
    if (o.hidden) S.lastFocus = document.activeElement;
    m.className = 'tp-modal ' + (kind || ''); m.innerHTML = html; o.hidden = false; o.dataset.kind = kind || '';
    document.body.classList.add('tp-modal-open');
    setTimeout(() => { (m.querySelector('[data-tp-autofocus]') || m.querySelector('input,select,textarea,button') || m).focus(); }, 20);
  }
  function closeModal() {
    const o = document.getElementById('tp-overlay'); if (!o || o.hidden) return;
    const was = o.dataset.kind; o.hidden = true; o.querySelector('.tp-modal').innerHTML = ''; document.body.classList.remove('tp-modal-open');
    S.popup = null; S.form = null;
    if (S.lastFocus && S.lastFocus.isConnected) try { S.lastFocus.focus(); } catch (e) { /* ignore */ }
    if (was === 'popup' && S.ctx && S.trial?.trial) mark('dismiss');
  }
  // focus trap + Escape
  document.addEventListener('keydown', e => {
    const o = document.getElementById('tp-overlay'); if (!o || o.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const f = [...o.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]')].filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ── trial pop-ups ──
  function popupHtml(kind) {
    const tr = S.trial || {}; const rem = Math.max(Number(tr.remaining) || 0, 0);
    const teacherNoPlan = tr.in_institution && !tr.is_admin;
    let head = ''; let cards = true; let actions = '';
    if (kind === 'gen2' && teacherNoPlan) {
      head = `<h2 id="tp-modal-title">${esc(t('inst_np_title'))}</h2><p>${esc(t('inst_np_body', { remaining: rem }))}</p>`;
      cards = false;
      actions = `<button type="button" class="tp-btn" data-tp="notify-admin" data-tp-autofocus>${esc(t('notify_admin'))}</button>
        <button type="button" class="tp-btn ghost" data-tp="sales">${esc(t('talk_sales'))}</button><button type="button" class="tp-link" data-tp="dismiss">${esc(t('keep_trying'))}</button>`;
    } else if (kind === 'gen2') {
      head = `<h2 id="tp-modal-title">${esc(t('gen2_title', { used: tr.used ?? 2 }))}</h2><p>${esc(rem === 1 ? t('gen2_body_one') : t('gen2_body', { remaining: rem }))}</p>`;
      actions = `<button type="button" class="tp-link" data-tp="dismiss" data-tp-autofocus>${esc(t('keep_trying'))}</button>`;
    } else if (kind === 'gen4') {
      head = `<h2 id="tp-modal-title">${esc(rem === 1 ? t('gen4_title', { remaining: rem }) : t('gen4_title_many', { remaining: rem }))}</h2><p>${esc(t('gen4_body'))}</p>`;
      cards = false;
      actions = `<button type="button" class="tp-btn" data-tp="show-plans" data-tp-autofocus>${esc(t('see_plans'))}</button><button type="button" class="tp-link" data-tp="dismiss">${esc(t('later'))}</button>`;
    } else { // limit (or "plans")
      const lim = tr.limit ?? trialCfg().generations_lifetime;
      head = kind === 'limit' ? `<h2 id="tp-modal-title">${esc(t('limit_title', { limit: lim }))}</h2><p>${esc(t('limit_body'))}</p>` : `<h2 id="tp-modal-title">${esc(t('title'))}</h2><p>${esc(t('subtitle'))}</p>`;
      actions = kind === 'limit'
        ? `<button type="button" class="tp-btn" data-tp="docente" data-tp-autofocus>${esc(t('choose_docente'))}</button><button type="button" class="tp-btn ghost" data-tp="sales">${esc(t('talk_sales'))}</button><button type="button" class="tp-link" data-tp="dismiss">${esc(t('close'))}</button>`
        : `<button type="button" class="tp-link" data-tp="dismiss" data-tp-autofocus>${esc(t('close'))}</button>`;
    }
    const grid = cards ? `<div class="tp-grid compact">${cardDocente(true)}${cardInst(true)}${cardPlus(true)}</div>` : '';
    return `<button type="button" class="tp-x" data-tp="dismiss" aria-label="${esc(t('close'))}">✕</button>${head}${grid}
      <div class="tp-actions">${actions}</div>
      <p class="tp-small tp-more"><span>${esc(t('questions'))}</span> <button type="button" class="tp-link" data-tp="sales">${esc(t('contact_us'))}</button> · <a href="/planes" target="_blank" rel="noopener">${esc(t('all_plans'))}</a></p>`;
  }
  async function showPopup(kind, source) {
    await loadPlans();
    S.popup = { kind, source: source || (kind === 'gen2' ? 'popup_gen2' : kind === 'gen4' ? 'popup_gen4' : kind === 'limit' ? 'paywall' : 'plans_page') };
    openModal(popupHtml(kind), 'popup');
  }

  // ── sales form ──
  function defaultCountry() {
    const l = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    const m = /-([A-Z]{2})$/i.exec(l); const c = m ? m[1].toUpperCase() : '';
    return COUNTRIES.includes(c) ? c : '';
  }
  function formHtml(o) {
    const u = S.ctx?.user?.() || null; const L = T[lang()];
    const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(l)}</option>`;
    const field = (id, label, input, req = true) => `<div class="tp-field" data-f="${id}"><label for="tpf-${id}">${esc(label)}${req ? ' <span aria-hidden="true">*</span>' : ''}</label>${input}<div class="tp-err" id="tpf-${id}-err" role="alert"></div></div>`;
    const ctry = defaultCountry();
    const pick = o.plan || 'unsure';
    return `<button type="button" class="tp-x" data-tp="close-form" aria-label="${esc(t('close'))}">✕</button>
      <h2 id="tp-modal-title">${esc(t('f_title'))}</h2><p>${esc(t('f_sub'))}</p>
      ${pick === 'docente' ? `<div class="tp-callout" id="tpf-docnote">${esc(t('doc_note'))}</div>` : ''}
      <form id="tp-form" novalidate>
        <div class="tp-form-grid">
        ${field('name', t('f_name'), `<input id="tpf-name" name="name" autocomplete="name" maxlength="120" required value="${esc(u?.name || '')}" data-tp-autofocus>`)}
        ${field('institution', t('f_institution'), `<input id="tpf-institution" name="institution" autocomplete="organization" maxlength="160" required value="${esc(o.institution || '')}">`)}
        ${field('role', t('f_role'), `<select id="tpf-role" name="role" required>${opt('', t('f_choose'))}${['direccion', 'coordinacion', 'docente', 'administracion', 'otro'].map(r => opt(r, L['r_' + r], o.role === r)).join('')}</select>`)}
        ${field('country', t('f_country'), `<select id="tpf-country" name="country" required>${opt('', t('f_choose'))}${COUNTRIES.map(c => opt(c, L.countries[c], c === ctry)).join('')}</select>`)}
        ${field('teachers_count', t('f_teachers'), `<select id="tpf-teachers_count" name="teachers_count" required>${opt('', t('f_choose'))}${['1-2', '3-9', '10-29', '30-99', '100+'].map(v => opt(v, v.replace('-', '–'), pick === 'docente' && v === '1-2')).join('')}</select>`)}
        ${field('preferred_plan', t('f_plan'), `<select id="tpf-preferred_plan" name="preferred_plan">${['docente', 'institucion', 'institucion_plus', 'unsure'].map(v => opt(v, L['p_' + v], v === pick)).join('')}</select>`, false)}
        </div>
        <fieldset class="tp-field" data-f="contact_channel"><legend>${esc(t('f_channel'))} <span aria-hidden="true">*</span></legend>
          <label class="tp-radio"><input type="radio" name="contact_channel" value="whatsapp" checked> ${esc(t('c_whatsapp'))}</label>
          <label class="tp-radio"><input type="radio" name="contact_channel" value="email"> ${esc(t('c_email'))}</label></fieldset>
        <div class="tp-form-grid">
        ${field('whatsapp', t('f_whatsapp'), `<input id="tpf-whatsapp" name="whatsapp" type="tel" autocomplete="tel" inputmode="tel" maxlength="24" placeholder="${esc(t('ph_whatsapp'))}">`)}
        ${field('email', t('f_email'), `<input id="tpf-email" name="email" type="email" autocomplete="email" maxlength="254" required value="${esc(u?.email || '')}">`)}
        </div>
        ${field('message', t('f_message'), `<textarea id="tpf-message" name="message" rows="3" maxlength="1000"></textarea>`, false)}
        <div class="tp-field" data-f="consent"><label class="tp-check"><input type="checkbox" id="tpf-consent" name="consent"> <span>${esc(t('f_consent'))}</span></label><div class="tp-err" id="tpf-consent-err" role="alert"></div></div>
        <div id="tpf-captcha" class="tp-captcha" hidden aria-label="${esc(t('captcha_label'))}"></div>
        <div class="tp-err tp-form-err" id="tpf-form-err" role="alert"></div>
        <div class="tp-actions"><button type="submit" class="tp-btn" id="tpf-send">${esc(t('f_send'))}</button><button type="button" class="tp-link" data-tp="close-form">${esc(t('f_cancel'))}</button></div>
      </form>`;
  }
  async function config() {
    if (S.cfg) return S.cfg;
    try { const r = await fetch('/api/config', { cache: 'no-store' }); S.cfg = r.ok && /json/.test(r.headers.get('content-type') || '') ? await r.json() : {}; } catch (e) { S.cfg = {}; }
    return S.cfg;
  }
  async function session() {
    const sb = S.ctx?.sb || window.__tcPlansSb;
    try { const { data } = await sb.auth.getSession(); return data?.session || null; } catch (e) { return null; }
  }
  let captchaToken = null; let captchaWidget = null;
  async function maybeCaptcha() {
    const box = document.getElementById('tpf-captcha'); if (!box) return;
    const ses = await session(); if (ses) return;
    const cfg = await config();
    if (!cfg.salesAnon || !cfg.turnstileSiteKey) {               // no anonymous leads: ask to sign in first
      showFormError(t('e_auth'), true, true); return;
    }
    box.hidden = false;
    const render = () => { try { captchaWidget = window.turnstile.render(box, { sitekey: cfg.turnstileSiteKey, callback: tok => { captchaToken = tok; }, 'expired-callback': () => { captchaToken = null; }, language: lang() }); } catch (e) { /* ignore */ } };
    if (window.turnstile) render();
    else {
      const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = render;
      document.head.appendChild(s);
    }
  }
  function showFormError(msg, auth, info) {
    const el = document.getElementById('tpf-form-err'); if (!el) return;
    el.classList.toggle('tp-info', !!info);
    el.innerHTML = esc(msg) + (auth ? ` <a href="/">${esc(t('sign_in'))}</a>` : '');
  }
  async function openSalesForm(o = {}) {
    if (S.ctx?.isViewAs?.()) { S.ctx.toast?.(t('e_viewas'), 'err'); return; }
    await loadPlans();
    const src = o.source || S.popup?.source || (S.page ? 'plans_page' : 'other');
    if (S.ctx && S.trial?.trial) mark('sales');
    captchaToken = null; captchaWidget = null;
    S.popup = null;
    S.form = { source: src, plan: o.plan || null };
    openModal(formHtml({ plan: o.plan, institution: S.ctx?.institutionName?.() || '' }), 'form');
    maybeCaptcha();
  }
  function validate(f) {
    const v = n => String(f.elements[n]?.value || '').trim();
    const errs = {};
    for (const n of ['name', 'institution', 'role', 'country', 'teachers_count', 'email']) if (!v(n)) errs[n] = t('e_required');
    const ch = f.querySelector('input[name="contact_channel"]:checked')?.value || 'whatsapp';
    const wa = v('whatsapp').replace(/[\s().-]/g, '');
    if (ch === 'whatsapp' && !wa) errs.whatsapp = t('e_required');
    else if (wa && !/^\+[0-9]{7,16}$/.test(wa)) errs.whatsapp = t('e_whatsapp');
    if (v('email') && !/^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[A-Za-z]{2,24}$/.test(v('email'))) errs.email = t('e_email');
    if (!f.elements.consent.checked) errs.consent = t('e_consent');
    return { errs, lead: { name: v('name'), institution: v('institution'), role: v('role'), country: v('country'), teachers_count: v('teachers_count'), contact_channel: ch,
      whatsapp: wa, email: v('email'), preferred_plan: v('preferred_plan') || 'unsure', message: String(f.elements.message.value || '').slice(0, 1000), consent: !!f.elements.consent.checked, lang: lang() } };
  }
  function showErrors(f, errs) {
    f.querySelectorAll('.tp-err').forEach(e => { if (e.id !== 'tpf-form-err') e.textContent = ''; });
    f.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid'));
    let first = null;
    for (const [k, msg] of Object.entries(errs)) {
      const e = document.getElementById(`tpf-${k}-err`); if (e) e.textContent = msg;
      const inp = document.getElementById(`tpf-${k}`) || f.querySelector(`[name="${k}"]`);
      if (inp) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', `tpf-${k}-err`); first = first || inp; }
    }
    if (first) first.focus();
  }
  async function submitForm(f) {
    const { errs, lead } = validate(f);
    showFormError('');
    if (Object.keys(errs).length) { showErrors(f, errs); return; }
    showErrors(f, {});
    const btn = document.getElementById('tpf-send'); btn.disabled = true; btn.textContent = t('f_sending');
    const ses = await session();
    let r = null; let data = null;
    try {
      r = await fetch('/api/notify/lead', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ses ? { Authorization: 'Bearer ' + ses.access_token } : {}) },
        body: JSON.stringify({ lead, source: S.form?.source || 'other', ...(captchaToken ? { turnstileToken: captchaToken } : {}) }) });
      data = /json/.test(r.headers.get('content-type') || '') ? await r.json() : null;
    } catch (e) { r = null; }
    btn.disabled = false; btn.textContent = t('f_send');
    if (r && r.ok && data?.ok) {
      if (S.trial) S.trial.lead_sent = true;
      const name = lead.name.split(/\s+/)[0] || lead.name;
      openModal(`<button type="button" class="tp-x" data-tp="close-form" aria-label="${esc(t('close'))}">✕</button><div class="tp-ok" role="status"><div class="tp-ok-ico" aria-hidden="true">✓</div>
        <h2 id="tp-modal-title">${esc(t('ok_title'))}</h2><p>${esc(lead.preferred_plan === 'docente' ? t('ok_body_docente', { name }) : t('ok_body', { name }))}</p>
        <div class="tp-actions"><button type="button" class="tp-btn" data-tp="close-form" data-tp-autofocus>${esc(t('close'))}</button></div></div>`, 'form done');
      S.ctx?.onLead?.(data);
      renderBanner();
      return;
    }
    const code = data?.code;
    if (code === 'auth') showFormError(t('e_auth'), true);
    else if (code === 'rate') showFormError(t('e_rate'));
    else if (code === 'captcha') { showFormError(t('e_captcha')); try { window.turnstile?.reset?.(captchaWidget); } catch (e) { /* ignore */ } captchaToken = null; }
    else if (code === 'consent') showErrors(f, { consent: t('e_consent') });
    else if (code === 'invalid' && data.field) showErrors(f, { [data.field]: data.field === 'email' ? t('e_email') : data.field === 'whatsapp' ? t('e_whatsapp') : t('e_required') });
    else showFormError(t('e_generic'));
  }

  // ── trial state (app only) ──
  async function mark(what) {
    const sb = S.ctx?.sb; if (!sb || S.ctx?.isViewAs?.()) return;
    try { const { data } = await sb.rpc('trial_mark', { p_what: what }); const d = typeof data === 'string' ? JSON.parse(data) : data; if (d && typeof d.trial === 'boolean') S.trial = { ...S.trial, ...d }; } catch (e) { /* best effort */ }
  }
  function eligible() { const u = S.ctx?.user?.(); return !!(u && !u.isStudent && !u.isSuperAdmin && !S.ctx?.isViewAs?.()); }
  async function refreshTrial() {
    if (!S.ctx) return null;
    if (!eligible()) { S.trial = null; renderBanner(); return null; }
    try {
      const { data, error } = await S.ctx.sb.rpc('my_trial_status');
      const d = typeof data === 'string' ? JSON.parse(data) : data;
      S.trial = !error && d && d.trial ? d : null;
    } catch (e) { S.trial = null; }
    if (S.trial) loadPlans();
    renderBanner();
    return S.trial;
  }
  function renderBanner() {
    const el = document.getElementById('trial-banner'); if (!el) return;
    const tr = S.trial;
    if (!tr || !tr.trial || !eligible()) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('tp-has-banner'); return; }
    const rem = Math.max(Number(tr.remaining) || 0, 0);
    const msg = rem <= 0 ? `<b>${esc(t('banner_zero', { limit: tr.limit }))}</b> <span class="tp-banner-sub">· ${esc(t('banner_zero_sub'))}</span>` : `<b>${esc(rem === 1 ? t('banner_one') : t('banner_many', { n: rem }))}</b>`;
    el.className = 'tp-banner' + (rem <= 0 ? ' out' : rem === 1 ? ' last' : '');
    el.setAttribute('data-no-i18n', ''); el.setAttribute('role', 'status');
    el.innerHTML = `<span class="tp-banner-ico" aria-hidden="true">${rem <= 0 ? '⛔' : '✨'}</span><span class="tp-banner-txt">${msg}</span> <button type="button" class="tp-banner-link" data-tp="show-plans-banner">${esc(t('banner_plans'))}</button>`;
    el.hidden = false; document.body.classList.add('tp-has-banner');
  }
  async function afterGeneration() {
    const tr = await refreshTrial();
    if (!tr || !tr.trial || tr.lead_sent) return;
    let kind = null;
    if (tr.used >= tr.reminder_at && tr.remaining > 0 && !tr.reminder_shown_at) kind = 'gen4';
    else if (tr.used >= tr.paywall_at && tr.used < tr.reminder_at && !tr.paywall_shown_at) kind = 'gen2';
    if (!kind) return;
    clearTimeout(S.popupTimer);
    S.popupTimer = setTimeout(() => {               // never interrupts: the class is already on screen
      const o = document.getElementById('tp-overlay');
      if (!eligible() || (o && !o.hidden)) return;
      showPopup(kind); mark(kind === 'gen2' ? 'paywall' : 'reminder');
    }, api.POPUP_DELAY_MS);
  }
  function onTrialLimit(info) {
    if (!eligible()) return;
    S.trial = { ...(S.trial || { trial: true }), trial: true, remaining: 0, used: info?.trial_used ?? S.trial?.used, limit: info?.trial_limit ?? S.trial?.limit ?? trialCfg().generations_lifetime };
    renderBanner();
    showPopup('limit'); mark('limit');
  }
  function beforeGenerate() {
    if (S.trial?.trial && Number(S.trial.remaining) <= 0 && eligible()) { onTrialLimit({}); return false; }
    return true;
  }
  async function notifyAdmin() {
    const msg = t('notify_admin_msg', { url: location.origin + '/planes' });
    let ok = false;
    try { await navigator.clipboard.writeText(msg); ok = true; } catch (e) { ok = false; }
    if (ok) { closeModal(); S.ctx?.toast?.(t('notify_admin_done'), 'ok', 6000); }
    else {
      const m = document.querySelector('#tp-overlay .tp-actions');
      if (m && !document.getElementById('tp-admin-msg')) m.insertAdjacentHTML('beforebegin', `<p class="tp-small">${esc(t('notify_admin_fail'))}</p><textarea id="tp-admin-msg" class="tp-copy" readonly rows="3">${esc(msg)}</textarea>`);
      document.getElementById('tp-admin-msg')?.select();
    }
  }

  // ── clicks ──
  document.addEventListener('click', e => {
    const el = e.target.closest?.('[data-tp],[data-tp-period],[data-tp-cur]'); if (!el) return;
    if (el.dataset.tpPeriod) { S.period = el.dataset.tpPeriod; try { localStorage.setItem('tc_plans_period', S.period); } catch (x) { /* ignore */ } rerender(); return; }
    if (el.dataset.tpCur) { S.cur = el.dataset.tpCur; try { localStorage.setItem('tc_currency', S.cur); } catch (x) { /* ignore */ } rerender(); return; }
    switch (el.dataset.tp) {
      case 'dismiss': e.preventDefault(); closeModal(); break;
      case 'close-form': e.preventDefault(); { const o = document.getElementById('tp-overlay'); if (o) o.dataset.kind = 'form'; } closeModal(); break;
      case 'docente': e.preventDefault(); openSalesForm({ plan: 'docente' }); break;
      case 'sales': e.preventDefault(); openSalesForm({ plan: el.dataset.planPick || (S.trial?.in_institution || !S.ctx ? 'institucion' : null) }); break;
      case 'show-plans': e.preventDefault(); showPopup('plans', 'popup_gen4'); break;
      case 'show-plans-banner': e.preventDefault(); showPopup(S.trial && Number(S.trial.remaining) <= 0 ? 'limit' : 'plans', Number(S.trial?.remaining) <= 0 ? 'paywall' : 'plans_page'); break;
      case 'notify-admin': e.preventDefault(); notifyAdmin(); break;
      case 'start': break; // plain link
    }
  });
  // a corrected field loses its error at once
  document.addEventListener('input', e => {
    const f = e.target?.closest?.('#tp-form .tp-field'); if (!f) return;
    const err = f.querySelector('.tp-err'); if (err) err.textContent = '';
    f.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
  });
  document.addEventListener('submit', e => { if (e.target?.id === 'tp-form') { e.preventDefault(); submitForm(e.target); } });
  document.addEventListener('change', e => {
    if (e.target?.name === 'contact_channel') {                 // WhatsApp required only when chosen
      const req = e.target.value === 'whatsapp'; const lab = document.querySelector('[data-f="whatsapp"] label');
      if (lab) lab.innerHTML = esc(t('f_whatsapp')) + (req ? ' <span aria-hidden="true">*</span>' : '');
    }
    if (e.target?.id === 'tpf-preferred_plan') {
      const note = document.getElementById('tpf-docnote');
      if (e.target.value === 'docente' && !note) document.getElementById('tp-form')?.insertAdjacentHTML('beforebegin', `<div class="tp-callout" id="tpf-docnote">${esc(t('doc_note'))}</div>`);
      if (e.target.value !== 'docente' && note) note.remove();
    }
  });

  function rerender() {
    if (S.page) renderPage();
    const o = document.getElementById('tp-overlay');
    if (o && !o.hidden && S.popup) openModal(popupHtml(S.popup.kind), 'popup');
    renderBanner();
  }

  // ── the standalone page (/planes) ──
  async function renderPage() {
    const root = document.getElementById('tp-root'); if (!root) return;
    document.documentElement.lang = lang();
    document.title = t('title');
    document.querySelectorAll('[data-tp-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tpLang === lang())));
    const ses = await session();
    const back = document.getElementById('tp-back'); if (back) back.textContent = ses ? t('back_app') : t('sign_in');
    if (!S.plans) root.innerHTML = `<p class="tp-loading">${esc(t('loading'))}</p>`;
    await loadPlans();
    root.innerHTML = pageHtml(!!ses);
  }
  function initPage({ sb }) {
    S.page = true; window.__tcPlansSb = sb;
    try { S.lang = localStorage.getItem('tc_ui_lang') || ''; } catch (e) { S.lang = ''; }
    if (!S.lang) S.lang = (navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
    let cur = null, per = null; try { cur = localStorage.getItem('tc_currency'); per = localStorage.getItem('tc_plans_period'); } catch (e) { /* ignore */ }
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
    S.cur = cur === 'EUR' || cur === 'USD' ? cur : (EU.test(navigator.language || '') || /^Europe\//.test(tz) ? 'EUR' : 'USD');
    S.period = per === 'monthly' ? 'monthly' : 'annual';
    const q = new URLSearchParams(location.search);
    if (q.get('lang') === 'en' || q.get('lang') === 'es') S.lang = q.get('lang');
    if (q.get('currency') === 'EUR' || q.get('currency') === 'USD') S.cur = q.get('currency');
    document.addEventListener('click', e => {
      const b = e.target.closest?.('[data-tp-lang]'); if (!b) return;
      S.lang = b.dataset.tpLang; try { localStorage.setItem('tc_ui_lang', S.lang); } catch (x) { /* ignore */ }
      rerender();
    });
    renderPage().then(() => { if (q.get('contact') === 'docente' || q.get('contact') === 'sales') openSalesForm({ plan: q.get('contact') === 'docente' ? 'docente' : 'institucion', source: 'plans_page' }); });
  }

  // ── app integration ──
  const api = {
    POPUP_DELAY_MS: 3000,
    init(ctx) { S.ctx = ctx; },
    reset() { S.trial = null; clearTimeout(S.popupTimer); closeModal(); renderBanner(); },
    loadPlans, refreshTrial, afterGeneration, onTrialLimit, beforeGenerate,
    trial: () => S.trial,
    watermark: () => !!(S.trial?.trial && S.trial.watermark !== false && eligible()),
    watermarkText: () => t('watermark'),
    openSalesForm, showPopup, closeModal,
    onLang() { rerender(); },
    initPage,
    money: (n, cur) => money(n, cur),
    _state: S,
  };
  window.TCPlans = api;
  // /planes boots itself (no inline script: CSP)
  function autoBoot() {
    const b = document.body; if (!b || !b.classList.contains('tp-page') || !window.supabase) return;
    initPage({ sb: window.supabase.createClient(b.dataset.sbUrl, b.dataset.sbKey) });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoBoot); else autoBoot();
})();
