# TeroClass

AI-powered didactic planning platform for teachers.

## Tech Stack

- Vanilla HTML/CSS/JS frontend (`public/index.html`)
- Supabase: accounts, institutions, class plans, logos (`supabase/migrations/001_base.sql`)
- Vercel serverless API (`api/generate.js`) that calls Azure OpenAI (gpt-4o). The Azure key lives only on the server.
- Groups, students and calendar: `public/groups-calendar.js` / `.css`, `public/csv-import.js` (CSV parser, also unit-tested in node), `api/calendar/feed.js` (calendar subscription),
  `api/notify/session.js` (email invitations, optional), `api/_lib/ics.js`.
- Class document + attendance: `public/class-doc.js` / `.css`, `public/attendance.js`, and the vendored editor
  `public/vendor/classdoc-editor.js` (Yjs 13.6.32 + TipTap 2.27.2, one pinned ES module loaded on demand; no build step —
  it is rebuilt only when upgrading, with `scripts/vendor/build-classdoc.sh`).
- Class whiteboard ("Pizarra"): `public/class-board.js` / `.css` and the vendored Excalidraw `public/vendor/whiteboard/`
  (React 18.3.1 + ReactDOM 18.3.1 + @excalidraw/excalidraw 0.18.1, MIT; one pinned ES module + lazy chunks + fonts, loaded only
  when a board is opened; rebuilt only when upgrading, with `scripts/vendor/build-whiteboard.sh`).

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Example |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | `https://<resource>.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | (secret) |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4o` |
| `AZURE_OPENAI_DEPLOYMENT_MINI` | (optional) `gpt-4.1-mini` — the name of a second deployment in the same Azure resource (owner checklist below). Used by *Platform → Compare models* and by the kinds of request switched to "Mini model" in *Platform → AI model*. Without it, "mini" falls back to `AZURE_OPENAI_DEPLOYMENT` (the screens say so). |
| `AZURE_OPENAI_API_VERSION` | `2024-12-01-preview` |
| `SUPABASE_SERVICE_ROLE_KEY` | (secret) Supabase → Project Settings → API Keys → `service_role` (or a new `sb_secret_…` key). Server only: turns on AI token limits and usage recording. Without it the app works without token limits and Platform shows a warning. |
| `RESEND_API_KEY` | (secret, **optional**) Turns on class invitation / update / cancellation emails with the event attached ([resend.com](https://resend.com)), and the email to the institution admins when someone does not agree to be recorded (that one also needs `SUPABASE_SERVICE_ROLE_KEY`, to read the admins' emails on the server). Without it nothing is sent: the app offers "Copy invitation link" and the justifications are only in Groups → Consents. |
| `NOTIFY_FROM` | (optional) Sender of those emails, e.g. `TeroClass <clases@teroclass.com>` (the domain must be verified in Resend). Default `TeroClass <no-reply@teroclass.com>`. |
| `APP_URL` | (optional) Public https origin used in links inside calendar events, e.g. `https://teroclass.com`. Default: the request's host. |
| `SALES_NOTIFY_EMAIL` | (optional) Where "Hablar con ventas" requests are e-mailed, e.g. `ventas@teroclass.com` (never hard-coded). Needs `RESEND_API_KEY` too. Without them requests are only in *Platform → Sales requests*, with a red badge on the Platform icon. |
| `TURNSTILE_SECRET_KEY` | (optional) Cloudflare Turnstile **secret**, only for the sales form **without signing in** on `/planes` (verified by `api/notify/lead.js`; also needs `TURNSTILE_SITE_KEY` and `SUPABASE_SERVICE_ROLE_KEY`). Without it the form asks people to sign in or create a free account first. (The same secret stays in Supabase for sign-up.) |
| `TURNSTILE_SITE_KEY` | (optional, public) Cloudflare Turnstile site key (TC-18). With it, sign-up, sign-in, the student magic link and "Forgot your password?" show the check and send its token to Supabase Auth (`captchaToken`). The **secret** (`TURNSTILE_SECRET_KEY`) is NOT set in Vercel: paste it in Supabase → Authentication → Bot and Abuse Protection (Turnstile). Without the site key nothing changes. |
| `RECORDING_ENABLED` | (optional, `true` only once a real recorder is connected) Makes the room say "● Recording — only people who gave consent". Without it the room says "Recording ready to be turned on — nothing is recorded yet" (TC-23). |
| `APP_ENV` | (optional) `production` on the production project. Any other value (e.g. `staging`) shows the thin "Versión de prueba" banner even on teroclass.com; any host other than teroclass.com / www.teroclass.com shows it anyway (P-21). |
| `ROOM_TICKET_SECRET` | (optional) Secret for the invitation links of quick live rooms (TC-13). Default: derived from `LIVEKIT_API_SECRET`. |
| `AI_IP_HOURLY_LIMIT` | (optional) AI requests per hour from one IP (default 300; a school shares one IP). |
| `RATE_LIMIT_SECRET` | (optional) Key for the HMAC of IPs in the rate limits (default: derived from the Azure key). |
| `SENTRY_DSN` | (optional) Browser and API errors are also sent to Sentry from the server (TC-12). |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | (optional) The real video classroom (see `docs/live-class.md`). |

## Database

Run `supabase/migrations/001_base.sql` in Supabase → SQL Editor (safe to re-run). **It changed again for plans and the free
trial (2026-10-21, see *Plans, free trial and sales*): run it again** — tested from git a4f00d3 with data, then twice; `002_live_class.sql`
did not change and still applies after it. **The first run marks every existing institution as "Pilot"** (nothing stops working);
set the ones that are not paying to "No plan" in *Platform*. Before that it changed for the class whiteboard
(2026-10-21, see *Class whiteboard*) — tested from git 3c0ef7b with data, then twice; `002_live_class.sql` did not
change and still applies after it. Before that it changed with the pre-launch
fix sprint (2026-10, see *Pre-launch fix sprint*) — tested from git 203e2e1 with data, then twice; earlier: (it upgrades the
previous version in place and keeps all data; tested from git 9993462 — and c198c60, d063eb0 — with data, then twice).
`002_live_class.sql` is still **not** needed; it changed too (its per-call `consents` table is now an audit log written only by
the server from `user_consents`) and it still applies after the new `001` (it now requires it).

### Platform owner (super admin)

The super admin role lives only in `profiles.role`. The script never promotes anyone by email and never
demotes an existing super admin, so re-running it keeps the current owner. To grant the role (once, in
Supabase → SQL Editor; replace the placeholder with the real account email):

```sql
update public.profiles set role='superadmin' where id=(select id from auth.users where email='OWNER_EMAIL_HERE');
```

The owner's identity (name, email, id) is never shown to institution admins or teachers: their profile is
hidden by RLS, and "created by / invited by / uploaded by / decided by" references to a super admin are
removed or masked (shown as "TeroClass team").

Institutions form a hierarchy of up to 3 levels: main institution › campus/faculty › department/area
(`institutions.parent_id`). Admins of a unit manage everything below it; sub-units inherit branding,
master prompt, playbooks and learning-approach bars (`get_effective_config`).

## Institution switcher and navigation

Next to the logo, the **institution switcher** picks the unit every institution screen works on: Structure,
Dashboard, Branding, AI Settings and Plan & usage show that unit and everything below it.
Super admin: *All institutions* (platform screens: Institutions, Metrics, Platform; and Institution → Insights) or any unit of the tree (searchable
when there are more than 8). Admins: only their own subtree (a single unit is shown as plain text). Teachers: no switcher.
The choice is remembered per person in the browser and checked against what they can access; *Institutions* in the
sidebar = *All institutions*; *View* on an institution card selects it. During *View as* it is locked to the viewed unit.
The sidebar shows a label under each icon, grouped as Teaching · Institution · Platform (icons only on phones).

## Metrics (super admin only)

*Metrics* (Spanish: *Métricas*; called "Insights" before 2026-10-18) shows product usage for the last 7 / 30 / 90 days, for all institutions or the selected unit and what is
below it (optionally without the owner's own activity): classes generated per day, active teachers (1/7/30 days), new and
returning users, generated vs saved classes, student handouts, top institutions; top subjects, teaching languages, age
bands, average learning-approach bars, institutions with a playbook; AI tokens (input/output) and an estimated cost in USD
(prices per 1M tokens in *Platform → AI cost estimate*, default GPT-4o 2.50 / 10.00).
Every AI request is recorded with its class settings (never the prompt text) in `ai_events` by `consume_ai_quota`,
with the user's own session, so this works **without** the server key; institution and user come from the profile.
Token counts and costs come from the server log and need `SUPABASE_SERVICE_ROLE_KEY` (the screen says so when it is
missing). Data is read only through `platform_insights` (super admin; totals only, no names; the RPC kept its name), which also
counts the classes with class insights in the period (`students.insight_sessions`).

## Class insights (Insights)

**Insights** = what each person can learn from a class (the analytics screen above is *Metrics*):
- **Teacher / substitute** — Teaching → *Insights*: their classes with insights, newest first. A class opens the **teacher
  observation report** (TEC Observation Guide: header with teacher, group/level, date, class objective, observation focus,
  students present, class length → *Evidence I noticed* (minutes, quotes, counts, tagged with the 13 observation areas) →
  *What worked well* (1–2) → *Priority area* (1) → *Suggested next step* (1) → *Teacher reflection*, typed and saved by the
  teacher) and the **students** of that class: *Summary · Recap · Progress · Feedback · Vocabulary* per student, with the
  **message from the teacher**: ✨ *Draft with assistant* proposes one, the teacher edits it, *Save draft*, *Publish to student*.
  The student sees only the published version (a later draft doesn't change it until it is published again).
- **Institution admin** — Institution → *Insights*: every class of the unit chosen in the switcher and below it, read-only
  (report, reflection, students, published messages). **Super admin**: the same screen with *All institutions* or a unit.
- **Student** — *My insights* on the dashboard (newest 5) and the full list (own insights only, newest first).
- Filters: group, teacher (admins), date range, student search (name or email, only within what that person can see).
- Language classes show grammar/pronunciation/CEFR; other subjects show concepts and disciplinary language instead (the sample is
  chosen from the class title / group name: "Química", "Math", "History"… → subject sample; "English B1"… → language sample).

**Data (today: demo).** Real insights will come from the recorded call (LiveKit + Azure Speech + AI), not active yet. Until then
**demo insights** are stored for real classes and flagged `is_demo` (the screens show "Demo data — real insights activate when
the live classroom is connected"):
- when a teacher or substitute **ends a class** opened from the Calendar in the live-class demo (then Insights opens on it);
- with **✨ Generate demo insights** on a class of today or before (Insights → *Recent classes without insights*, or the class
  detail in the Calendar). One report per class and one row per enrolled student (group members + invited emails), with varied
  sample content; repeating it is harmless (only students added later get their row).

**Database (`001_base.sql`, no direct table access; security-definer functions only).** `teacher_insights` (one per calendar
class: `class_sessions`) and `student_insights` (one per class and **enrollment**, so a student is the person the institution
loaded; names and emails are never stored in the insight data). Functions: `generate_demo_insights` (teacher / substitute of the
class or an admin of its unit; payload built by `public/insights-view.js`), `list_insight_sessions`, `get_session_insights`,
`save_teacher_reflection` and `save_insight_message` (teacher / substitute only), `my_insights` / `my_insight` (the student's own;
super admin with an enrollment for *View as*). Privacy: a student sees only their own insights and their own **published**
message (never drafts, the teacher report, the reflection or classmates); teachers see the classes of the groups they teach or
substitute in (and their one-off classes); admins only their subtree; the reflection is visible to the teacher and the unit's
admins, never students.
**Reconciliation with `002_live_class.sql`** (not run in production): insights belong to the *calendar class*, not to the call,
so the tables moved to `001`; `002` now only links them to the call — `live_sessions.class_session_id` (the class taught in that
call) and `student_insights.participant_id` (FK to `session_participants`) — drops its old insight policies and requires the new
`001`. Running `002` after `001` (any number of times) changes nothing else. A database where an old `002` had created insight
tables tied to `live_sessions` keeps them as `*_live_legacy` (empty ones are dropped).
**Limitations (class insights).** All insights are sample data until the recorded live class is connected (same content for
every class of a subject type, varied per student; real numbers, quotes and pronunciation audio need the recording); the
assistant draft is a template built from the student's feedback, not an AI call; a guardian has no access to a minor's
insights yet; access follows the group: a teacher replaced in a group stops seeing its past classes' insights and the new one
sees them; removing a student from the unit deletes their insights; generated demo insights can't be removed from the app.

## View as (super admin only)

The platform owner can see the app exactly as an institution sees it, without creating accounts:
*Platform → 👁 View as…*, the account menu, or *👁 View as* on any unit in *Structure*. Pick a unit (any level),
a perspective (institution admin or teacher) and optionally a person of that unit (to see their saved classes).
The whole UI then behaves as that role in that unit (navigation, mode switch, inherited branding, learning-approach
bars, prompt/playbook chain, Structure limited to that subtree, Plan & usage, Dashboard, Live class, Home).
It is a client-side overlay (auth is not touched) and strictly **read-only**: every save/invite/role change/upload/
purchase/approval is blocked ("View as is read-only"), also at the Supabase-client and fetch level. Generating a
class is allowed as a preview with that unit's settings; it is never saved and the AI tokens count to the owner.
A persistent banner shows who you are viewing as; *Exit* restores your session; a reload always starts normally.

## Plan & usage (seats + monthly classes)

Each main institution is a billing account: **seats** (teachers + admins in its whole tree) and a **monthly allowance** of AI
tokens (calendar month, UTC), shown to admins as **classes** (1 class = 25,000 tokens; see *Plans, free trial and sales*). When the
allowance is used up, purchased **class packs** (extra balance, no expiry yet) are used. There are no payments in the app: an
admin of the main institution requests a pack (50 classes = USD 25, 200 = USD 85) in *Plan & usage*, the super admin charges
outside the app (transfer / Mercado Pago) and approves it in *Platform*, which adds the classes. Pack prices live in the plans
(*Platform → Plans & pricing*); the free monthly allowance for users without an institution and the defaults for new institutions
are in *Platform → Defaults*. Token accounting happens only on the server (`api/generate.js` → `ai_budget_check` /
`ai_record_usage`, executable only with the service key).

## Plans, free trial and sales (2026-10-21)

Pricing proposal v1 (`plans.json`), as decided by the owner: **Free trial** 5 classes in total · **Docente** USD 12/month or
USD 99/year (EUR 11.99 / 99, VAT incl.) · **Institución** per teacher per month, billed yearly: USD 14 (3–9), 12 (10–29), 10 (30–99);
monthly ≈ 20% more (17 / 14.50 / 12) · **Institución+** custom (reference USD 9 + onboarding) · class packs 50 = USD 25, 200 = USD 85,
analyzed-class packs, AI tracking, classroom-hour pack · launch offers (off until switched on). **There is no online payment yet**:
a plan is activated by hand in *Platform* once paid (Uruguayan SAS: transfer + e-invoice; Paddle / Polar later for self-serve).

- **Plans as data.** `platform_settings.plans` (seeded once from `plans.json`, never overwritten by a re-run) → `get_plans()`
  (public, also without a session). *Platform → Plans & pricing* edits prices, limits, packs and the launch-offer switches
  (`update_plans`, super admin only, validated). Texts live in `public/plans.js` (Spanish "vos" + English) and always take the
  numbers from the data.
- **"Clases", not tokens.** 1 class = 25,000 tokens (`credit_tokens`). *Plan & usage* shows classes this month / left, extra
  classes from packs, the account's plan status and the class packs to request (`request_token_pack(p_pack)`; the old 10M-token
  pack for USD 11.99, sold at a loss, is gone; old requests and balances are kept and shown as ≈ classes). Server messages talk
  about classes and class packs.
- **Who is on trial.** Teachers and admins (never students, never the super admin) with no institution, or whose institution
  (main institution = billing account) has no **active plan**: `billing_accounts.plan_status` ∈ `pilot`, `active`, `founder`,
  `enterprise` (others: `none`, `cancelled`), set by the super admin in *Platform → Institutions: plan and usage* ("Apply plan" also
  sets the monthly classes to seats × classes per teacher). People without an institution get a **Teacher plan** in *Platform →
  Teacher plans* (`individual_plans`; 25 classes/month).
- **Trial rules, enforced in the database with the user's own token** (works without the server key): `consume_ai_quota`
  counts completed main generations (`ai_events` kind `generate`, `ok`), lifetime; in-flight ones count too (two requests at once
  can't pass the limit; one advisory lock per person); failed ones don't — and only the server can mark a request as failed (it
  holds the request's `finish_key`). At the 6th → `trial_limit` → `/api/generate` **402** `{code:'trial_limit'}`. Follow-up
  requests (continuation, calculation check, student handout) are allowed only right after a counted class (2 h, max 6), so
  "continue" can't be used to get classes for free.
- **What people see** (`public/plans.js`): a persistent banner "Te quedan N clases de prueba · Ver planes" (amber at the last
  one, red when used up); after the **2nd** completed class, 3 s after the class is on screen, the plans pop-up (once:
  `trial_state`, `trial_mark`); after the **4th**, a short reminder; when the **6th** is attempted the app opens the plans pop-up
  (and the server refuses it anyway). Everything already created can still be viewed and exported; trial PDFs carry the watermark
  "Creado con TeroClass — versión de prueba". A teacher of an institution without a plan gets the variant "Tu institución todavía
  no tiene un plan activo" with *Avisarle a mi admin* (copies a short message with the /planes link). After a sales request, no
  more pop-ups (banner only). Copy is honest: no countdowns, no invented scarcity, no "most popular" claim; the Founding offer only
  says "N places left" when real accounts already have it.
- **`/planes` (`/plans`)** — `public/planes.html` + `plans.js` + `plans.css`: works without signing in; monthly / yearly toggle,
  USD / EUR (EUR by default for Spain / EU browsers; Docente "IVA incluido", Institución "+ IVA"), the Institución tier table,
  add-ons, launch offers (only when on), FAQ (students free, what a class is, classroom hours, transfer, running out, privacy).
  Linked from the user menu (*Planes y precios*) and *Plan & usage*. `?lang=en`, `?currency=EUR`, `?contact=sales` work.
- **"Hablar con ventas"** (pop-up, /planes, "Quiero el plan Docente" = the same form preselected with "El pago online llega
  pronto"): name, institution, role, country, teachers, WhatsApp / e-mail, preferred plan, message, consent →
  `POST /api/notify/lead` → `submit_sales_lead` with the person's session (validated, 3 per hour / 10 per day per person, per-IP
  limit) or, without a session, only with Turnstile fully configured (`submit_sales_lead_service`, per-IP HMAC limits). Table
  `sales_leads`: no direct access; only the super admin reads it (*Platform → Sales requests*: status nuevo / contactado /
  ganado / perdido, notes, CSV export with formula-safe cells, a red badge for new ones). E-mail to `SALES_NOTIFY_EMAIL` when
  `RESEND_API_KEY` exists (reply-to = the lead). The person's own requests are in *Download my data*.
- **AI model** (*Platform → AI model*): per kind of request (class + continuation / student handout / playbook summary /
  calculation check) "Default model" or "Mini model" (`ai_model_default`); `/api/generate` uses `AZURE_OPENAI_DEPLOYMENT_MINI`
  for "mini" and falls back to the default deployment if it is missing. Mini prices (USD per 1M tokens, defaults 0.40 / 1.60 from
  the proposal — **to verify** against the Azure price sheet) next to the default model's (*AI cost estimate*).
- **Compare models** (*Platform*, super admin only): type a topic (with the generator's current settings) or load the last 20
  saved classes; each pair runs the **same full pipeline** (guide, continuation, calculation check, handout) through
  `/api/generate` with `model: 'default' | 'mini'` — accepted **only from the super admin** (decided by the database:
  `consume_ai_quota` → `reason:'model'` → 403 for anyone else). Random left/right order, model names hidden until rated; time,
  tokens and estimated cost per side; rate A better / B better / same + note → `model_comparisons` (super admin only; cost
  recomputed with the stored prices); summary with win rates and average cost per class per model.
- **Métricas → Free trial → plans:** new accounts in the period, on trial, reached the 2nd class, saw the plans pop-up, used the
  whole trial, sales requests, converted (institutions / Teacher plans moved to an active plan in the period). Totals only.

**Database (`001_base.sql`).** `platform_settings.plans`, `ai_model_default`, `ai_price_input_mini`, `ai_price_output_mini`;
`billing_accounts.plan_status / plan_id / plan_activated_at / plan_changed_at`; `token_purchase_requests.pack_id / pack_credits`;
`ai_events.finish_key`; tables `individual_plans`, `trial_state`, `sales_leads`, `model_comparisons` (RLS on, no grants:
security-definer functions only). Functions: `get_plans`, `update_plans`, `my_trial_status`, `trial_mark`,
`set_institution_plan_status`, `set_individual_plan`, `list_individual_plans`, `submit_sales_lead`, `submit_sales_lead_service`,
`sales_lead_notified(_service)`, `list_sales_leads`, `update_sales_lead`, `sales_leads_new_count`, `save_model_comparison`,
`model_comparison_summary`, `get_model_comparison`, `update_ai_model_default`, `update_ai_prices_mini`, `platform_funnel`;
`consume_ai_quota(p_meta, p_est_tokens, p_model)` and `finish_ai_event(p_event, p_ok, p_key)` replace the old signatures (calls
with the old arguments keep working).

**Limitations (plans).** No online payment or invoicing: plans, Teacher plans and packs are activated by hand. Packs still don't
expire (one balance per account; the 12-month expiry of the proposal needs pack lots). Only the class limits are enforced: video
hours, analyzed classes, storage, methodologies, participants and the per-plan feature switches (calendar, CSV import…) are
shown on the plans page but not limited in the app yet. The trial is per person (5 classes); the proposal's pooled 15-class trial
for an institution without a plan was not built. The 24-hour gap between pop-ups and the e-mail sequence of the proposal were
not built. The watermark is added by the browser's print view (a determined user can remove it). Prices by purchasing power
(zone C) are not shown. A trial person can still get up to 6 follow-up requests right after each counted class.

## Groups, students and calendar

**Model.** Institution › campus › department › **group** (e.g. "English B1 – Tue/Thu"). A group belongs to one unit, has
**one teacher** and optionally **one substitute** (same access to the group's classes and students), and many students.
A group can exist without a teacher for a while (e.g. created by a CSV import); the Groups screen shows "Not assigned".

**Students are a role (`student`) and are free:** they never use seats (seats count teachers + admins only) and they don't
belong to a unit (`profiles.institution_id` stays empty). Their link to an institution is an **enrollment**
(`student_enrollments`): "this unit loaded this email (and name)". The email is stored exactly as loaded.

**Institution admins** (Institution → *Groups*, for the unit chosen in the switcher and everything below it): create /
edit / delete groups, assign or change the teacher and substitute, add students one by one (email + name, optional group),
**import a CSV** (below). Move a student to another group, remove from a group or from the unit.
The teacher or substitute can be someone **not registered yet**: in *Edit group* pick an invited email (or *Invite someone
by email…*); they get an invitation as teacher of that unit (same permission and seat rules as *Invite*), the group shows
*Pending: email (invited)*, and they are assigned automatically as soon as they register or accept the invitation
(trigger `profiles_claim_pending_groups`; also when an existing account is added to the unit). Pending emails are only
returned to admins of that institution (`list_groups`).

**CSV import (groups, students and their schedule).** One row per student; `public/csv-import.js` reads the file in the
browser (no build) and the database re-validates everything (`import_students`).
- Columns (any order, Spanish or English, case and accents ignored): `email`, `name/nombre`, `group/grupo`, `unit/unidad`
  (name or slug), `teacher_email/docente`, `substitute_email/suplente`, `days/días`, `start_time/hora/hora_inicio`,
  `end_time/hora_fin` **or** `duration/duración` (minutes), `start_date/desde/inicio`, `end_date/hasta/fin`,
  `timezone/zona`. Comma, semicolon or tab; up to 2,000 rows; downloadable template (Spanish headers in Spanish UI).
- Days: "Lun;Mié", "L,Mi", "lunes y miércoles", "Mon/Wed", "LMi", "lun a vie" ("Mi" = Wednesday, "Ma" = Tuesday;
  "M" or "T" alone are ambiguous → row error). Times: 07:00, 7:00, 7am, 19:30, 19h30, "07:00-08:00". Dates: DD/MM/YYYY
  (day first, as in Uruguay), YYYY-MM-DD, DD/MM (this year); "04/25/2027" (month/day) and invalid dates are errors.
- Teacher, substitute, schedule and time zone belong to the **group**: repeat them or fill them on one row only (also a
  row with a group and no email defines a group without students). Different values for the same group → row error.
- Preview per group (rows → groups → classes per teacher): unit, teacher/substitute (registered, will be invited, already
  invited, has an account, no free seats), schedule in words ("Lun y Mié 07:00–08:00, del 3/3 al 30/11"), number of classes
  that will be created, students, per-row errors and warnings.
- Commit, in this order: groups → teacher and substitute (registered: assigned; otherwise pending + invitation) →
  enrollments → a weekly series (`session_series.origin = 'csv'`) with its classes (up to one year). **Only future classes
  are created** (dates already passed are skipped and counted in the preview).
- Re-importing the same file creates nothing new. If a group's schedule changed, the preview says *Schedule changes*
  (before → now) and the commit moves only **future classes that were not edited one by one** (same rule as editing a
  series, `tc_series_apply`); past classes are never touched or deleted. A group that already has another teacher keeps
  them (warning in the preview).
A read-only *Calendar* tab lists the unit's classes for the next 4 weeks.

**Teachers and substitutes** (Teaching → *Calendar*): week view and agenda (the agenda is the default on phones).
*Schedule class*: a **weekly series** for a group (weekdays, start time, duration, from/until — up to one year; times use the
group's time zone; every class is stored as a row) or **one class**, for a group or without a group inviting students by
email. An email that is not yet a student of the institution is loaded by that teacher into their unit (same privacy rules).
Edit or cancel **one class** (a class edited on its own keeps its changes when the series is edited) or the **whole series**
(from today on). Everything is stored in UTC (`timestamptz`) and shown in the viewer's local time, with the time zone
labelled. **Enter room / Join** opens the existing live-class demo for that session id (same room for its teacher and
students). The **teacher and substitute can always enter** a class that is not cancelled (to prepare or test) from the
*Today's / Next class* card at the top of the Calendar, the week-view event detail and the agenda list; outside class time
it says "Students can join from 10 min before". **Students** can join from 10 minutes before the start until the end;
before that the button is disabled and says "Opens at HH:MM" (in their time zone).

**Privacy (enforced in the database, not only in the screens).** The new tables have no direct access at all; everything
goes through security-definer functions:
- an institution's admins see only the emails and names **that institution loaded**; if two institutions load the same
  person, each has its own enrollment and neither sees the other's;
- a teacher sees names + emails of the students of the groups they teach or substitute in (and of the people invited to
  their own one-off classes), nothing else; a teacher who leaves the institution stops being teacher/substitute of its groups;
- a student sees their groups, classes, the teacher's display name, how many classmates there are, and their own data —
  never classmates' emails; student profiles are never visible to admins through `profiles`;
- the super admin sees everything; the owner's identity stays hidden ("TeroClass team");
- `ai_events` never gets student data (students can't generate); Metrics shows only totals (loaded students, signed in,
  with classes in the period, groups, classes held, classes with insights).

**Student sign-in: a link by email, no password.** The login screen has *I'm a student → get a link by email*
(`supabase.auth.signInWithOtp`; also `/?student`). After the link is opened, `claim_enrollments()` links every enrollment whose
email equals the account's **verified** email (case-insensitive) — only when that session was opened from an email link /
code (Supabase `amr` claim), so a password sign-up with someone else's email can't take their classes. New magic-link
accounts get the role `student` and **only** see their dashboard; without enrollments they get a friendly "no classes yet"
screen and no access to the generator. Teacher registration and invitations work as before (an invited email that uses the
link still joins as the invited teacher/admin). A teacher/admin who is also enrolled keeps their role and sees those classes
in their Calendar ("As a student").
**Supabase settings to check:** Authentication → URL Configuration: *Site URL* = the production URL and *Redirect URLs*
including it (and the Vercel preview URL), otherwise the link lands on the wrong site. **Rate limit:** Supabase's built-in
email sender allows only a few emails per hour for the whole project — fine for testing, not for a class. **Pending for
Ignacio: configure a custom SMTP** (Authentication → Emails → SMTP Settings, e.g. with @teroclass.com) before real use.

**Student dashboard** (nothing else: no generator, bars, admin screens or switcher; language toggle and error toasts stay):
📅 *Calendar* (upcoming classes), ▶️ *Enter class* (the next/current class with a big Join button), 💡 *My insights* (their newest
insights, or an empty/preview state; *See all my insights* opens the full list — see *Class insights*).

**Calendars without an email provider.** Every class has *Add to Google Calendar* and an `.ics` download. Each teacher and
student has a personal subscription feed: `/cal/<token>.ics` (→ `api/calendar/feed.js`; also
`/api/calendar/feed?token=…`). The token is random and can be reset (the old link stops working); the feed is built by the
`calendar_feed` function called with the publishable key and contains only that person's classes (no emails, no other
students' data, cancelled classes marked as cancelled, times in UTC). The UI offers *Subscribe in Google Calendar*, *Copy feed
URL*, *Outlook / Apple Calendar* (webcal) and *Reset link*. **Email notifications** (`api/notify/session.js`) are a "dummy
feature" like the live class: they send only when `RESEND_API_KEY` exists; otherwise the app shows "email not configured"
and offers *Copy invitation link*.

**View as → Student** (super admin): pick a unit, then a group, optionally a student — the student dashboard, read-only.

**Minors and consent.** Many students are under 18: their "yes" to recording needs a parent/guardian's name and email and
the student's declaration that the guardian agrees (shown as "declared by the student", not verified), unless the
institution turns on `institutions.consent_managed_by_institution` (*Dashboard → Recording consent of minors*): then it
declares it collected the families' consent itself and minors are not asked for guardian details. TODO: real guardian
verification by email.

**Limitations.** A CSV import creates only future classes (past dates in the file are skipped); a CSV never replaces a
group's current teacher (only fills an empty or pending one); one imported schedule per group (one start time for all its
days); a schedule without an end date is reported as incomplete; a pending teacher is assigned by the email they register
with (with "Confirm email" ON, see the header of `001_base.sql`); with no free seats the pending email is kept but no
invitation is sent. Editing a whole series moves only future classes that weren't edited one by one; changing a group's time
zone doesn't move classes already scheduled; a one-off class's invitees are set when it is created; the live class is still
the demo (real video needs LiveKit and a session-aware token: `api/class/token.js`); a student who changes their account
email keeps the classes already linked.

## Class document (Documento de la clase)

One shared document per calendar class, like a Google Doc: everyone in the class reads and types at the same time, the
teacher can paste the class there, and it stays as a record afterwards.
- **Who:** the class's teacher and substitute (or whoever created a one-off class) and its students (group members and
  invited emails) read and edit live. Institution admins of that unit (and above) and the super admin: **read-only**
  (Groups → group card → *Classes & documents* → *Read document*). Nobody else (checked in the database on every read
  and write). View as is read-only.
- **Lock:** the teacher locks it (students read only) and unlocks it. After the class it stays open for editing unless
  locked.
- **Where:** the class detail in the Calendar (*Open class document*), the *Documento* tab inside the live room, the student
  dashboard (*Class document* on the next class, 📄 on each class, and *Class documents* = their past classes, 90 days), the
  admin's group card.
- **Editor:** headings, bold / italic / strike, bulleted and numbered lists, quotes, tables (add/remove rows and columns),
  links (http/https/mailto only), undo/redo; names, colours and cursors of the people in the document.
- **Paste a class (teacher):** inserts the **student handout** of one of their saved classes (cleaned again with the same
  filter that removes answer keys, "Answer: …" lines and teacher timings). The teacher guide is never inserted; a class
  without a handout yet is shown disabled. (The optional private teacher-only note was skipped.)
- **History:** a version every 10 minutes while people write, one at the end of the class (when the teacher ends the class
  in the live room, or before the first change made after the class ended), the ones the teacher saves, and one before
  every restore; max 20 per document (the end-of-class one is kept). Everyone with access can open them; **only the teacher
  restores** (everyone's open document reloads on the restored version).
- **Export:** Print / PDF (the browser prints only the document), HTML and Markdown downloads.

**How it syncs.** Editor = TipTap 2 + Yjs (CRDT). Every local change is sent to `classdoc_push` (a Yjs update, base64; the
database checks access, the lock and the size, and numbers changes in order); everyone reads new changes with
`classdoc_pull`; an editor sends a compact snapshot now and then (`classdoc_snapshot`) and older changes are deleted.
**Realtime only carries "there are changes, read them" pokes and cursor positions, never the document content**, on the
*private* channel `classdoc:<class id>`, authorized by the same access check through policies on `realtime.messages`
(`tc_classdoc_listen`: anyone with access; `tc_classdoc_send`: teacher and students). If private channels are not available
the app uses a public channel with an unguessable name returned only by `classdoc_open` (same rule: no content travels on
it); if Realtime is not available at all it reads every 2 seconds and shows "Live sync unavailable: updates every few
seconds". Names and colours of the people in a document come from the database (`classdoc_pull` presence), never from other
browsers. Tables: `class_docs`, `class_doc_updates`, `class_doc_versions`, `class_doc_presence` (no direct access).

**Supabase dashboard steps (Ignacio):**
1. Run the new `001_base.sql` (it creates the two policies on `realtime.messages`; check them in Database → Policies →
   schema `realtime` → `messages`: `tc_classdoc_listen` and `tc_classdoc_send`).
2. Realtime must be enabled for the project (it is by default). Private channels need nothing else.
3. Recommended: Realtime → Settings → turn **off** "Allow public access" (only private channels are allowed). The app keeps
   working (it then never uses the public fallback channel). If you leave it on, the app still tries the private channel first.
4. If the project was very old and `realtime.messages` did not exist when you ran `001`, run `001` again after enabling
   Realtime (it creates the policies only when that table exists). Without the policies everything still works by polling.

**Limitations (class document).** Fast typing reaches others in well under a second with Realtime, every 2 s without it;
cursors only move live with Realtime (without it they refresh every 2 s); the names on the cursors are the ones the school
loaded; a student removed from the group loses access immediately, but a browser that is already open keeps what it has
already loaded; a restore discards edits that someone was typing at that very moment; images, colours, comments and
suggestion mode are not supported; there is no offline editing (unsent changes are retried while the page is open); the
teacher-only private note for the teacher guide was not built.

## Class whiteboard (Pizarra)

One shared drawing board per calendar class (Excalidraw): everyone in the class draws at the same time, the teacher can lock
it, and it stays as a record afterwards.
- **Who:** the same people as the class document — the class's teacher and substitute (or whoever created a one-off class)
  and its students (group members and invited emails) draw live; institution admins of that unit (and above) and the super
  admin: **read-only** (Groups → group card → *Classes & documents* → *See board*, or the class detail). Nobody else (checked
  in the database on every read and write). View as is read-only.
- **Lock:** the teacher locks it (students only look; Excalidraw's view mode) and unlocks it. Also enforced by the database
  and by the Realtime policy (a locked student can't join the channel as a sender).
- **Where:** *Pizarra* tab in the live room's side panel (+ *Pantalla completa*: the board covers the video stage, the room
  controls stay), *Abrir pizarra* in the class detail of the Calendar, the student dashboard (*Pizarra* on the next class,
  🖍️ on each class, *Pizarras de tus clases* = boards of their past classes, 90 days), the admin's group card.
- **Tools:** Excalidraw's shapes, arrows, lines, free drawing (pencil), text, eraser, frames and the laser pointer; Spanish
  UI (Excalidraw's own `es-ES` texts). **Images and embedded web pages are disabled for now** (tool hidden, a pasted /
  dropped image is removed with a message, and the database refuses them) — they would need file storage; the library
  panel and "Mermaid → diagram" are hidden too.
- **History:** a version every 10 minutes while people draw, one at the end of the class (ending the class in the live
  room, or before the first change after the class ended), the ones the teacher saves, one before every restore; max 20 per
  board. Everyone with access can preview them; **only the teacher restores** (every open board reloads on it).
- **Export:** PNG and SVG (Excalidraw's exporters; also its own *Export image* dialog in the board menu).
- **Phones and tablets:** Excalidraw's touch UI (bottom bar, pinch zoom); finger drawing works.

**How it syncs.** Each browser sends **only the elements it changed** to `classboard_push` (~300 ms after the last change,
at least every 1.2 s while drawing). The database validates every element (allowed type, id, `version`, `versionNonce`,
max 256 KB, no `customData`, links only http(s) / mailto) and keeps, per element, the highest `version` (same version: the
lowest `versionNonce` — Excalidraw's own reconcile rule), numbering every accepted change (`rev`) so `classboard_pull`
returns only what is new. **Cap: 2 MB per board** ("La pizarra llegó a su tamaño máximo (2 MB): borrá dibujos que ya no
uses…"; deleting frees space; a warning shows from 80 %). On the *private* Realtime channel `classboard:<class id>` the
changed elements also travel so the others see a stroke while it is drawn, plus the pointers (names and colours come from
the database through `classboard_pull`, never from other browsers). **Nothing is stored from the channel**: a browser only
draws what it receives (after the same type / size checks) and reconciles it with `reconcileElements`; anything that no
pull confirms within a few seconds is replaced by the stored version or removed. The public fallback channel (unguessable
name from `classboard_open`) only carries "changes, pull" pokes and pointers; without Realtime the board reads every 2 s and
says "Live sync unavailable". Tables (no direct access): `class_boards`, `class_board_elements`, `class_board_versions`,
`class_board_presence`.

**Library and CSP.** Excalidraw needs React: `public/vendor/whiteboard/whiteboard.js` (1.30 MB, **423 KB gzip**, plus
`excalidraw.css` 145 KB / 23 KB gzip) is loaded with `import()` only when a board opens; its lazy chunks (Spanish/English
texts, PNG/SVG export helpers) and fonts are in the same folder (2.1 MB in total; the CJK font Xiaolai, 13 MB, is left out:
Chinese/Japanese text uses the system font). `window.EXCALIDRAW_ASSET_PATH` points at `/vendor/whiteboard/` and the build
also replaces Excalidraw's CDN fallback for fonts, so nothing is requested from another origin; font *subsetting* for SVG
export (WebAssembly) is replaced by embedding the whole (already small) font file, so the CSP did not change (no
`wasm-unsafe-eval`). `tests/e2e-csp.cjs` opens a board, draws and exports under the real headers.

**Supabase dashboard steps (Ignacio):**
1. Run the new `001_base.sql`. It creates two more policies on `realtime.messages`: check Database → Policies → schema
   `realtime` → `messages`: `tc_classboard_listen` and `tc_classboard_send` (next to `tc_classdoc_listen` / `tc_classdoc_send`).
2. Nothing else: Realtime is already used by the class document. Keeping "Allow public access" **off** (recommended) is fine.

**Limitations (class whiteboard).** No images or embedded pages yet; one board per calendar class — **quick rooms started
outside the calendar have no board** (they are not in the database: their access is a signed link checked only by the
server; schedule a one-off class to get one); pointers move live only with Realtime (every 2 s without it); a restore
discards strokes that someone was drawing at that very moment; two people moving the same shape at the same instant: the
last saved version wins; Excalidraw's own Spanish texts are from Spain (and a few of its hints are still in English); the
shared shape library isn't available; no offline drawing (unsent changes are retried while the page is open); a student who
was already connected when the board was locked can't send drawings (the app stops, the database refuses them and the
others' screens drop anything not stored), but the Realtime policy itself is checked when joining the channel.

## Attendance (Asistencia)

- **Automatic (today):** when a student enters the room of a calendar class (*Enter class* → lobby → *Join*) the app calls
  `attendance_join` (allowed from 10 minutes before the start until the end), sends `attendance_heartbeat` every minute
  while they are in the room and `attendance_leave` when they leave or close the tab (if the tab dies, the last heartbeat
  counts as the exit; minutes only count inside the class time). **Late** = joined more than N minutes after the start;
  N = `institutions.attendance_late_minutes` of the unit or the nearest unit above, 10 by default (an admin can change it
  with `select public.set_attendance_late_minutes('<unit id>', 15);`, no screen yet). Students with no record are **absent**
  once the class has ended (computed when reading). The teacher's own presence is recorded too.
- **Teacher corrections:** in the class detail (Calendar) the teacher or substitute sees each student's status, minutes,
  first join and "in the room now", and can set Present / Late / Absent / Excused (or back to Automatic) and a note
  (`set_attendance`, source `teacher`: it wins over the automatic status, and the future AI/video data never overrides it).
  Admins see the same list read-only.
- **Group report** (teacher / substitute from the class detail; admins read-only from the group card → *Attendance*):
  each student's % (present + late over the classes counted; excused and classes in progress are not counted) and
  present / late / absent / excused, a classes × students matrix, date range (default 90 days) and **CSV export** (name,
  email as loaded by that institution, status per class; `;` separator in Spanish). Students added to the group later are
  not counted for earlier classes.
- **Student:** "Attended 9 of 10 classes" on their dashboard (only their own; never classmates).
- **Metrics (super admin):** `students.attendance` in `platform_insights` = total rate, no names.
- **Later — real video + AI:** `attendance_record_external` (executable only with the service key) is the hook for
  `api/livekit/webhook.js` (participant_joined / participant_left → source `auto`) and for the AI participation estimate
  (`participation_seconds`, source `ai`). Not wired yet; it never overrides a teacher correction.
- Table `session_attendance` (one row per class and enrollment; teacher rows with `kind = 'teacher'`), no direct access.

**Limitations (attendance).** It only knows who entered the TeroClass room (the live class is still a demo: a student who
joins by another channel is absent unless the teacher corrects it); minutes are counted with a one-minute heartbeat; one-off
classes appear in the class detail but not in a group report; the late threshold has no screen yet (SQL / RPC only).

## Recording consent (Consentimiento de grabación)

**One checkbox, asked once.** The first time a person enters any class room (students **and teachers**: the teacher's voice is
needed for the observation report) the lobby shows a single checkbox: *"Acepto que mis clases en TeroClass se graben (solo audio)
y que la IA las analice para generar mis insights y mejorar las clases."* It covers recording + AI analysis + storage (original
audio deleted after 30 days) and has a short *Más información* note. A **yes** is stored per person in the database and is
permanent: the next classes don't ask again while it is valid and the text version matches. When the text changes, bump
`CONSENT_VERSION` in `public/live-class.js`, `api/class/token.js` **and** `tc_consent_version()` in `001_base.sql` (a test checks
they match): everyone is asked again.
- **Under 18** ("Soy menor de 18 años", same step): guardian's name + email + "Mi madre, padre o tutor/a está de acuerdo (lo
  declaro yo)" (`guardian_source = 'student'`), or nothing when the institution manages it (`guardian_source = 'institution'`).
- **No** → a pop-up "Está bien" with an **optional** comment ("¿Querés contarnos por qué? (opcional)"; P-11) and "Entrar sin
  que me graben". The person joins **not recorded** and is asked again at their next class. Only a written comment reaches
  the admins of that person's institution (students: the unit(s) that loaded them for that class; teachers: their unit), with
  an email when `RESEND_API_KEY` + `SUPABASE_SERVICE_ROLE_KEY` exist (`api/notify/consent.js`); an empty "no" is only counted.
- **Revoke** — account menu → *Grabación de mis clases: Activada / Desactivada*. Turning it off asks for confirmation and sets
  `revoked_at`; the person is asked again at the next class, and can turn it back on from the same menu (same checkbox; guardian
  fields for minors).
- **Admins** — Institution → *Groups* → **Consentimientos** (unit chosen in the switcher and below): each person's status
  (accepted + date, did not accept + date, revoked + date, pending — also "not signed in yet"), the minor flag ("Menor de 18 ·
  tutor/a ✓", never the guardian's name or email), the justifications with date and class, filters (status, role, search),
  **CSV export** (`;` in Spanish). A red badge on *Groups* counts the justifications that arrived since the admin last opened the
  tab (remembered per browser). *View as* shows it read-only.
- **Métricas** (super admin): a *Recording consent* tile with totals only (accepted / did not accept / pending), no names.
- **Server-side truth:** `api/class/token.js` ignores any consent sent by the browser; it reads `my_consent()` with the user's own
  session and puts `recorded`, `consent`, `minor`, `guardian_consent` in the LiveKit metadata from there (never guardian data). If it
  can't be read, the person joins not recorded.

**Database (`001_base.sql`).** `user_consents` (user, version, granted_at, revoked_at + reason, minor + guardian name/email/consent;
one active row per person) and `consent_declines` (user, institution, class, role, version, text, notified_at). RLS: each person
reads only their own rows; justifications also by the admins of that unit's subtree (and the super admin); nobody writes directly.
Functions: `my_consent`, `grant_recording_consent`, `revoke_recording_consent`, `decline_recording_consent`, `consent_overview`
(admin), `consent_new_declines` (badge), `platform_consent_counts` (super admin, totals), `consent_decline_notify_payload`
(service role only: the admins' emails never reach the browser). Privacy: an institution sees only the people it loaded (names
and emails as it loaded them) and the justifications addressed to it; classmates and teachers see nothing; the owner never appears.
**Reconciliation with `002_live_class.sql`:** its `consents` table (per call and participant) stays as an audit log: the server
(service role) copies the current `user_consents` row into it when a call is recorded (`consents.user_consent_id`); the browser can
no longer insert there, and `revoke_consent()` there also revokes the person's `user_consents`.

**Limitations (recording consent).** The recorder itself doesn't exist yet (classes are "recorded" only in the UI: indicator,
badges, pause); revoking while already inside a room takes effect from the next class; a pause resumes after 5 minutes counted in
the teacher's browser; the "new" badge is remembered per browser (another device shows the same justifications as new); the
email goes to the admins of the unit and the units above it (not the super admin); a student loaded by two institutions has one
consent, and each institution sees its status but only its own justifications; a guardian has no account or access of their own.

## Pre-launch fix sprint (2026-10) — what changed and what the owner must do

Findings TC-xx (technical audit) and P-xx (product audit). Summary of the behaviour that changed:

- **Join by link off by default** (TC-02 / P-13): existing institutions are switched to "invitation only" ONCE when the new
  `001_base.sql` runs; admins turn it on in *Dashboard → Join by link* (with a warning: every person uses a seat).
- **Invitations** (P-03 / P-04 / TC-07 / TC-16): honest result screen (link to copy, WhatsApp, email; an email is promised
  only if `RESEND_API_KEY` sent it), *Dashboard → Invitations* (copy link, resend, cancel), 14-day expiry. Inviting an
  EXISTING account creates a pending invitation that the person accepts or declines in the app ("Ana invited you to join
  … as …"); nobody is moved silently, a super admin is never moved or downgraded.
- **Password recovery** (TC-04): "Forgot your password?" → `resetPasswordForEmail` → "choose a new password" (min. 8).
- **AI cost guardrails without the server key** (TC-01): `/api/generate` accepts only the app's own request kinds and
  prompts (`api/_lib/guard.js`), per-kind `max_tokens`, a per-IP limit, requests per day, and **estimated tokens per day**
  per teacher and per institution (Platform → *AI daily limits*; defaults 400,000 / 3,000,000). Accounts without an
  institution: 3 requests / 30,000 tokens (unconfirmed email), 5 / 60,000 (first week), 15 / 150,000 after.
- **Timeouts** (TC-09): Azure is called in streaming with a total deadline of 55 s (Vercel stops at 60 s; Azure gets
  ≈ 50 s). If time runs out the text written so far comes back with `finish_reason: "length"` and the app asks for the
  continuation in a second short request, so a long class is split instead of failing. (The browser still receives one
  JSON answer: streaming to the browser would need a build step; this keeps every request under the limit.)
- **Emails** (TC-08): daily cap per teacher (30 sends / 300 recipients), max 100 per send, cleaned subject, and only
  people the institution loaded (or who already signed in) are emailed.
- **Live classroom** (TC-13 / P-09 / P-07 / TC-23): quick rooms need the creator's invitation link (`api/class/ticket`);
  the role comes from the server; invented participants / sample plan / sample insights only in "🧪 Try the demo";
  "Recording" only with `RECORDING_ENABLED`.
- **Minors** (P-10 / TC-17): the guardian's agreement is *declared by the student* (shown so, not verified) or the
  institution declares it collects the families' consent (*Dashboard → Recording consent of minors*). Declining needs no
  reason ("¿Querés contarnos por qué? (opcional)"). **TODO: real guardian verification by email.**
- **Security headers + self-hosted libraries** (TC-10 / TC-11 / TC-22): CSP and friends in `vercel.json`; supabase-js
  2.116.0, livekit-client 2.22.3, pdf.js 4.10.38 (`isEvalSupported:false`), mammoth 1.13.0 and Inter in `public/vendor/`
  (exact versions). `tests/e2e-csp.cjs` runs the app under the real headers.
- Class document capped at 2 MB (TC-14); a sign-out / other account in another tab reloads the page (TC-15); deleting a
  group or removing a student can be undone for 10 s (P-14); Privacy and Terms drafts at `/privacidad` and `/terminos`
  (TC-06 / P-12, "Borrador — debe revisarlo un abogado", placeholders [RAZÓN SOCIAL], [RUT], [DIRECCIÓN], [EMAIL DE
  CONTACTO]); "Versión de prueba" banner outside production (P-21).

**Database:** `001_base.sql` and `002_live_class.sql` changed: run `001` again, then `002` if you use it (tested from git
203e2e1 with data, then twice; `002` still applies after it).

### Owner checklist (accounts, money, lawyer — not solvable in code)

- [ ] Vercel **Pro** (commercial use) and Supabase **Pro** (no pause, daily backups) — TC-03.
- [ ] Vercel env: `SUPABASE_SERVICE_ROLE_KEY` (monthly token budget), `APP_URL=https://teroclass.com`, `APP_ENV=production`
      on production (and `staging` on preview), optionally `TURNSTILE_SITE_KEY`, `SENTRY_DSN`. `RESEND_API_KEY` /
      `NOTIFY_FROM` and the `LIVEKIT_*` variables can now be loaded (TC-08 / TC-13 are fixed). `RECORDING_ENABLED` only
      when a real recorder exists.
- [ ] Supabase Auth: Site URL + Redirect URLs (prod, preview, `/org/*`, `/?reset=1`), **Confirm email ON**, own SMTP
      (e.g. Resend with @teroclass.com), minimum password length 8, Bot and Abuse Protection → Turnstile with the secret
      key — TC-05 / TC-18. Realtime: turn off "Allow public access".
- [ ] Class whiteboard (2026-10-21): run the new `001_base.sql` and check that Database → Policies → `realtime.messages` lists
      `tc_classboard_listen` and `tc_classboard_send` (see *Class whiteboard*). No new environment variable.
- [ ] **Azure budget alerts** (TC-01): Azure portal → Cost Management → Budgets → *Add*: monthly budget for the
      resource group of the OpenAI resource, alerts at 50 %, 80 % and 100 % to your email; and in Azure AI Foundry →
      Deployments → `gpt-4o` → set a **tokens-per-minute (TPM) limit** that fits your plan. The app limits are a second
      line of defence, not a bill cap.
- [ ] Rotate the keys that were shared in chats (GitHub, Supabase).
- [ ] Lawyer: review `/privacidad` and `/terminos`, fill [RAZÓN SOCIAL], [RUT], [DIRECCIÓN], [EMAIL DE CONTACTO];
      DPA with Supabase, Microsoft, Vercel, LiveKit, Resend; register the database with the URCDP (Uruguay); consent
      model for minors (and whether guardian verification by email is required before recording minors).
- [ ] Uptime monitor (Better Stack / UptimeRobot) on `/api/health`.
- [ ] **Plans (2026-10-21):** run the new `001_base.sql`; then in *Platform → Institutions: plan and usage* set each institution's
      plan status (every existing one starts as **Pilot**; "No plan" puts its teachers on the 5-class trial); check prices in
      *Platform → Plans & pricing*; switch on the launch offers you want.
- [ ] **Sales e-mails:** Vercel env `SALES_NOTIFY_EMAIL=<your sales inbox>` (+ `RESEND_API_KEY`, already used for invitations).
      Optional, for the form without signing in on /planes: `TURNSTILE_SECRET_KEY` in Vercel (same secret as in Supabase) +
      `TURNSTILE_SITE_KEY` + `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] **gpt-4.1-mini deployment (Azure AI Foundry), for Compare models:**
      1. Go to https://ai.azure.com, open the **same project / Azure OpenAI resource** that has the `gpt-4o` deployment (the one
         whose endpoint is `AZURE_OPENAI_ENDPOINT`).
      2. Left menu → **Models + endpoints** (older UI: *Deployments*) → **+ Deploy model** → **Deploy base model**.
      3. Search **gpt-4.1-mini**, select it → **Confirm**.
      4. **Deployment name:** `gpt-4.1-mini` (any name works; it must be exactly what you put in Vercel). **Deployment type:**
         *Global Standard* (or *Standard* in your region if data residency matters). Model version: the latest offered.
      5. **Customize** → *Tokens per Minute Rate Limit*: start with ~50K TPM (enough for the comparison; raise it if you switch kinds
         to mini). Leave content filter = Default. **Deploy**.
      6. Check the API version: the deployment page shows a sample with `api-version=…`; `AZURE_OPENAI_API_VERSION`
         (`2024-12-01-preview`) works for gpt-4.1-mini. Same endpoint and key as gpt-4o — no new key.
      7. Vercel → Settings → Environment Variables → add `AZURE_OPENAI_DEPLOYMENT_MINI` = `gpt-4.1-mini` (Production + Preview) →
         **Redeploy**.
      8. In TeroClass: *Platform* → the "mini model is not configured" warning disappears → *Compare models* → load the last 20 saved
         classes (e.g. The English Coach) → compare and rate each pair. Only after deciding, switch kinds to "Mini model" in
         *Platform → AI model*.
      9. Verify the price: Azure portal → Cost Management, or the Azure OpenAI pricing page → gpt-4.1-mini input / output per 1M
         tokens → update *Platform → AI model → Mini model price*. Add the new deployment to the budget alert.

## Tests

`tests/e2e-mock.cjs`, `tests/e2e-qa-fixes.cjs`, `tests/e2e-hierarchy.cjs`, `tests/e2e-billing.cjs`, `tests/e2e-viewas.cjs`, `tests/e2e-nav-insights.cjs` (switcher, sidebar, Metrics), `tests/e2e-students-calendar.cjs` (groups, CSV import, calendar, student magic link, View as Student, mobile), `tests/e2e-csv-schedule.cjs` (CSV with schedules, pending teachers, enter the room), `tests/e2e-insights.cjs` (class insights per role, demo generation, reflection, publish a message, student privacy, admin subtree, View as, mobile, Métricas), `tests/e2e-classdoc.cjs` (two browsers editing the same class document through a simulated Realtime broadcast, lock, paste a class without answers, admin read-only, live room tab, polling fallback, history/restore, export, mobile), `tests/e2e-classboard.cjs` (class whiteboard: two browsers drawing on the same board through the simulated Realtime channel, lock, broadcasts never stored, admin read-only, live room tab + full screen, polling fallback, history/restore, PNG/SVG export, images refused, phone with touch drawing; `SHOTS=<dir>` saves `wb-*.png`) `tests/e2e-attendance.cjs` (join → present for the teacher, corrections, admin group report + CSV, student summary, mobile) and `tests/e2e-consent.cjs` (one checkbox asked once, decline + required justification → admin Consentimientos + badge + CSV, profile revoke / turn on, minor + guardian, auto-recording + pause, View as, Métricas, mobile; `SHOTS=<dir>` saves `cons-*.png`) run the app in a headless browser
against a simulated Supabase (`NODE_PATH=/opt/npm-tools/node_modules node tests/<file>`).
Pre-launch fixes: `tests/e2e-launch-fixes.cjs`, `tests/e2e-sprint-fixes.cjs` (`SHOTS=<dir>` saves `fix-*.png`) and
`tests/e2e-csp.cjs` (the app under the real `vercel.json` headers / CSP); `tests/api-launch.test.mjs` and
`tests/sql/launch_fixes.sql` (also run after an upgrade from git 203e2e1 with data).
Plans and free trial (2026-10-21): `tests/e2e-plans.cjs` (trial pop-up at the 2nd class, reminder at the 4th, hard block at the 6th
with the plans pop-up — also when the server refuses it —, watermark, active-plan teachers / super admin / students never see it,
/planes ES + EN desktop + mobile, sales form → the super admin's list (status, notes, CSV, badge), "Quiero el plan Docente", Plan &
usage in classes + packs, plans editor + launch offers + plan status + Teacher plan, compare models with two mock outputs and the
rating saved, the per-kind model setting; `SHOTS=<dir>` saves `pay-*.png`), `tests/api-plans.test.mjs` (`trial_limit` 402, finish
key, model accepted only from the super admin, mini deployment + fallback, sales form API: session / Turnstile / e-mail / errors)
and `tests/sql/plans.sql` (get_plans, trial counting with the user token, in-flight and failed classes, follow-ups, active plans,
Docente plan, model override, update_plans validation, sales_leads and model_comparisons privacy + rate limits, funnel; also after
an upgrade from git a4f00d3 with data). `tests/e2e-csp.cjs` opens the plans pop-up and /planes under the real headers.

`tests/sql/run.sh` runs the database security suites (base guarantees, hierarchy permissions, plan & usage, insights, students & calendar privacy, and the upgrade path from the previous `001`) on a local
Postgres 16: `PGHOST=… PGPORT=… PGUSER=postgres tests/sql/run.sh` (includes `csv_schedule.sql`, `class_insights.sql`,
`classdoc_attendance.sql` (class document access matrix, lock, versions/restore, Realtime policies; attendance privacy, late
rule, overrides, report), `classboard.sql` (class whiteboard: access matrix, element validation, last-writer-wins, lock, 2 MB
cap, versions/restore, Realtime policies; also after an upgrade from git 3c0ef7b with data), `consent.sql` (recording consent: privacy, grant / revoke / version, minors, justifications visibility,
admin overview, Métricas, notification payload), the upgrades from git fabb1c7, c198c60, d063eb0 and 9993462 with data, and
`002_live_class.sql` + its RLS suite after the current `001`).
CSV parser unit tests: `node --no-warnings --test tests/unit-*.test.mjs`.
API: `node --no-warnings --test tests/api-*.test.mjs` (billing, live class, recording consent in the token + admin emails, AI metadata, calendar feed + notifications).

## Live class (Aula en vivo)

In-app video classroom, currently in **Demo mode** (simulated participants, sample insights, no cost). Classes are **recorded
automatically** (audio only, only people who consented — see *Recording consent*): an indicator "● Grabando — solo quienes dieron
su consentimiento" is always visible and the teacher can *Pausar grabación / Reanudar* (a pause resumes by itself after 5 minutes);
there is no REC button any more. Ending a class opened from the
Calendar (teacher / substitute) stores demo insights for that class (see *Class insights*). A class opened from the Calendar has a
*Documento* side tab (the class document) and records attendance (see *Attendance*). The insights renderers are shared:
`public/insights-view.js` / `.css` (live-class demo + Insights panels), panels in `public/insights-panel.js`.
To connect real video set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in Vercel.
See `docs/live-class.md` (activation, costs, privacy checklist). Tests: `tests/e2e-live.cjs`,
`tests/api-live.test.mjs`, `tests/sql/002_live_class_rls.sql`.
