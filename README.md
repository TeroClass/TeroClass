# TeroClass

AI-powered didactic planning platform for teachers.

## Tech Stack

- Vanilla HTML/CSS/JS frontend (`public/index.html`)
- Supabase: accounts, institutions, class plans, logos (`supabase/migrations/001_base.sql`)
- Vercel serverless API (`api/generate.js`) that calls Azure OpenAI (gpt-4o). The Azure key lives only on the server.

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Example |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | `https://<resource>.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | (secret) |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4o` |
| `AZURE_OPENAI_API_VERSION` | `2024-12-01-preview` |
| `SUPABASE_SERVICE_ROLE_KEY` | (secret) Supabase → Project Settings → API Keys → `service_role` (or a new `sb_secret_…` key). Server only: turns on AI token limits and usage recording. Without it the app works without token limits and Platform shows a warning. |

## Database

Run `supabase/migrations/001_base.sql` in Supabase → SQL Editor (safe to re-run).

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

## Tests

`tests/e2e-mock.cjs`, `tests/e2e-qa-fixes.cjs`, `tests/e2e-hierarchy.cjs`, `tests/e2e-billing.cjs`, `tests/e2e-viewas.cjs` and `tests/e2e-nav-insights.cjs` (switcher, sidebar, Insights) run the app in a headless browser
against a simulated Supabase (`NODE_PATH=/opt/npm-tools/node_modules node tests/<file>`).

`tests/sql/run.sh` runs the database security suites (base guarantees, hierarchy permissions, plan & usage, insights) on a local
Postgres 16: `PGHOST=… PGPORT=… PGUSER=postgres tests/sql/run.sh`.
API: `node --no-warnings --test tests/api-billing.test.mjs tests/api-live.test.mjs tests/api-meta.test.mjs`.

## Live class (Aula en vivo)

In-app video classroom, currently in **Demo mode** (simulated participants, sample insights, no cost).
To connect real video set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in Vercel.
See `docs/live-class.md` (activation, costs, privacy checklist). Tests: `tests/e2e-live.cjs`,
`tests/api-live.test.mjs`, `tests/sql/002_live_class_rls.sql`.
