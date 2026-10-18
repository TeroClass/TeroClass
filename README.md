# TeroClass

AI-powered didactic planning platform for teachers.

## Tech Stack

- Vanilla HTML/CSS/JS frontend (`public/index.html`)
- Supabase: accounts, institutions, class plans, logos (`supabase/migrations/001_base.sql`)
- Vercel serverless API (`api/generate.js`) that calls Azure OpenAI (gpt-4o). The Azure key lives only on the server.
- Groups, students and calendar: `public/groups-calendar.js` / `.css`, `api/calendar/feed.js` (calendar subscription),
  `api/notify/session.js` (email invitations, optional), `api/_lib/ics.js`.

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Example |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | `https://<resource>.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | (secret) |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4o` |
| `AZURE_OPENAI_API_VERSION` | `2024-12-01-preview` |
| `SUPABASE_SERVICE_ROLE_KEY` | (secret) Supabase → Project Settings → API Keys → `service_role` (or a new `sb_secret_…` key). Server only: turns on AI token limits and usage recording. Without it the app works without token limits and Platform shows a warning. |
| `RESEND_API_KEY` | (secret, **optional**) Turns on class invitation / update / cancellation emails with the event attached ([resend.com](https://resend.com)). Without it nothing is sent and the app offers "Copy invitation link". |
| `NOTIFY_FROM` | (optional) Sender of those emails, e.g. `TeroClass <clases@teroclass.com>` (the domain must be verified in Resend). Default `TeroClass <no-reply@teroclass.com>`. |
| `APP_URL` | (optional) Public https origin used in links inside calendar events, e.g. `https://teroclass.com`. Default: the request's host. |

## Database

Run `supabase/migrations/001_base.sql` in Supabase → SQL Editor (safe to re-run). **It changed with Groups + Students +
Calendar: run it again** (it upgrades the previous version in place and keeps all data).

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
Super admin: *All institutions* (platform screens: Institutions, Insights, Platform) or any unit of the tree (searchable
when there are more than 8). Admins: only their own subtree (a single unit is shown as plain text). Teachers: no switcher.
The choice is remembered per person in the browser and checked against what they can access; *Institutions* in the
sidebar = *All institutions*; *View* on an institution card selects it. During *View as* it is locked to the viewed unit.
The sidebar shows a label under each icon, grouped as Teaching · Institution · Platform (icons only on phones).

## Insights (super admin only)

*Insights* shows product usage for the last 7 / 30 / 90 days, for all institutions or the selected unit and what is
below it (optionally without the owner's own activity): classes generated per day, active teachers (1/7/30 days), new and
returning users, generated vs saved classes, student handouts, top institutions; top subjects, teaching languages, age
bands, average learning-approach bars, institutions with a playbook; AI tokens (input/output) and an estimated cost in USD
(prices per 1M tokens in *Platform → AI cost estimate*, default GPT-4o 2.50 / 10.00).
Every AI request is recorded with its class settings (never the prompt text) in `ai_events` by `consume_ai_quota`,
with the user's own session, so this works **without** the server key; institution and user come from the profile.
Token counts and costs come from the server log and need `SUPABASE_SERVICE_ROLE_KEY` (the screen says so when it is
missing). Data is read only through `platform_insights` (super admin; totals only, no names).

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

## Plan & usage (seats + AI tokens)

Each main institution is a billing account: **seats** (teachers + admins in its whole tree) and a **monthly AI token
allowance** (calendar month, UTC). When the allowance is used up, purchased **token packs** (extra balance, no expiry)
are used. There are no payments in the app: an admin of the main institution requests a pack in *Plan & usage*, the
super admin charges outside the app (transfer / Mercado Pago) and approves it in *Platform*, which adds the tokens.
Pack size/price/currency, the free monthly allowance for users without an institution and the defaults for new
institutions are set in *Platform → Plans & pricing*. Token accounting happens only on the server
(`api/generate.js` → `ai_budget_check` / `ai_record_usage`, executable only with the service key).

## Groups, students and calendar

**Model.** Institution › campus › department › **group** (e.g. "English B1 – Tue/Thu"). A group belongs to one unit, has
**one teacher** and optionally **one substitute** (same access to the group's classes and students), and many students.
A group can exist without a teacher for a while (e.g. created by a CSV import); the Groups screen shows "Not assigned".

**Students are a role (`student`) and are free:** they never use seats (seats count teachers + admins only) and they don't
belong to a unit (`profiles.institution_id` stays empty). Their link to an institution is an **enrollment**
(`student_enrollments`): "this unit loaded this email (and name)". The email is stored exactly as loaded.

**Institution admins** (Institution → *Groups*, for the unit chosen in the switcher and everything below it): create /
edit / delete groups, assign or change the teacher and substitute, add students one by one (email + name, optional group),
**import a CSV** (columns `email, name, group`, optional `teacher_email` and `unit` (name or slug); any order — the header
decides; comma or semicolon; up to 2,000 rows; a downloadable template). Before importing, a preview validates every row
(bad email, repeated in the file, unknown teacher/unit, ambiguous unit, unknown group → "create the new groups" option).
Importing the same file again creates no duplicates. Move a student to another group, remove from a group or from the unit.
A read-only *Calendar* tab lists the unit's classes for the next 4 weeks.

**Teachers and substitutes** (Teaching → *Calendar*): week view and agenda (the agenda is the default on phones).
*Schedule class*: a **weekly series** for a group (weekdays, start time, duration, from/until — up to one year; times use the
group's time zone; every class is stored as a row) or **one class**, for a group or without a group inviting students by
email. An email that is not yet a student of the institution is loaded by that teacher into their unit (same privacy rules).
Edit or cancel **one class** (a class edited on its own keeps its changes when the series is edited) or the **whole series**
(from today on). Everything is stored in UTC (`timestamptz`) and shown in the viewer's local time, with the time zone
labelled. **Join** opens the existing live-class demo for that session (same room for its teacher and students); it is
enabled from 10 minutes before the start until the end, and shows "Starts in …" before that.

**Privacy (enforced in the database, not only in the screens).** The new tables have no direct access at all; everything
goes through security-definer functions:
- an institution's admins see only the emails and names **that institution loaded**; if two institutions load the same
  person, each has its own enrollment and neither sees the other's;
- a teacher sees names + emails of the students of the groups they teach or substitute in (and of the people invited to
  their own one-off classes), nothing else; a teacher who leaves the institution stops being teacher/substitute of its groups;
- a student sees their groups, classes, the teacher's display name, how many classmates there are, and their own data —
  never classmates' emails; student profiles are never visible to admins through `profiles`;
- the super admin sees everything; the owner's identity stays hidden ("TeroClass team");
- `ai_events` never gets student data (students can't generate); Insights shows only totals (loaded students, signed in,
  with classes in the period, groups, classes held).

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
📅 *Calendar* (upcoming classes), ▶️ *Enter class* (the next/current class with a big Join button), 💡 *My insights* (an
empty/preview state: insights need recording, which is not active yet; ready to read `student_insights`).

**Calendars without an email provider.** Every class has *Add to Google Calendar* and an `.ics` download. Each teacher and
student has a personal subscription feed: `/cal/<token>.ics` (→ `api/calendar/feed.js`; also
`/api/calendar/feed?token=…`). The token is random and can be reset (the old link stops working); the feed is built by the
`calendar_feed` function called with the publishable key and contains only that person's classes (no emails, no other
students' data, cancelled classes marked as cancelled, times in UTC). The UI offers *Subscribe in Google Calendar*, *Copy feed
URL*, *Outlook / Apple Calendar* (webcal) and *Reset link*. **Email notifications** (`api/notify/session.js`) are a "dummy
feature" like the live class: they send only when `RESEND_API_KEY` exists; otherwise the app shows "email not configured"
and offers *Copy invitation link*.

**View as → Student** (super admin): pick a unit, then a group, optionally a student — the student dashboard, read-only.

**Minors and consent.** Many students are under 18. Nothing is recorded today, so there is no consent flow yet.
`institutions.consent_managed_by_institution` (default false) is reserved for institutions that collect parental consent
themselves. **TODO before activating recording:** ask the parent/guardian's consent (the live-class lobby already has the
UI) or rely on that flag, and document it in the privacy policy.

**Limitations.** Editing a whole series moves only future classes that weren't edited one by one; changing a group's time
zone doesn't move classes already scheduled; a one-off class's invitees are set when it is created; the live class is still
the demo (real video needs LiveKit and a session-aware token: `api/class/token.js`); a student who changes their account
email keeps the classes already linked.

## Tests

`tests/e2e-mock.cjs`, `tests/e2e-qa-fixes.cjs`, `tests/e2e-hierarchy.cjs`, `tests/e2e-billing.cjs`, `tests/e2e-viewas.cjs`, `tests/e2e-nav-insights.cjs` (switcher, sidebar, Insights) and `tests/e2e-students-calendar.cjs` (groups, CSV import, calendar, student magic link, View as Student, mobile) run the app in a headless browser
against a simulated Supabase (`NODE_PATH=/opt/npm-tools/node_modules node tests/<file>`).

`tests/sql/run.sh` runs the database security suites (base guarantees, hierarchy permissions, plan & usage, insights, students & calendar privacy, and the upgrade path from the previous `001`) on a local
Postgres 16: `PGHOST=… PGPORT=… PGUSER=postgres tests/sql/run.sh`.
API: `node --no-warnings --test tests/api-*.test.mjs` (billing, live class, AI metadata, calendar feed + notifications).

## Live class (Aula en vivo)

In-app video classroom, currently in **Demo mode** (simulated participants, sample insights, no cost).
To connect real video set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in Vercel.
See `docs/live-class.md` (activation, costs, privacy checklist). Tests: `tests/e2e-live.cjs`,
`tests/api-live.test.mjs`, `tests/sql/002_live_class_rls.sql`.
