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

Institutions form a hierarchy of up to 3 levels: main institution › campus/faculty › department/area
(`institutions.parent_id`). Admins of a unit manage everything below it; sub-units inherit branding,
master prompt, playbooks and learning-approach bars (`get_effective_config`).

## Plan & usage (seats + AI tokens)

Each main institution is a billing account: **seats** (teachers + admins in its whole tree) and a **monthly AI token
allowance** (calendar month, UTC). When the allowance is used up, purchased **token packs** (extra balance, no expiry)
are used. There are no payments in the app: an admin of the main institution requests a pack in *Plan & usage*, the
super admin charges outside the app (transfer / Mercado Pago) and approves it in *Platform*, which adds the tokens.
Pack size/price/currency, the free monthly allowance for users without an institution and the defaults for new
institutions are set in *Platform → Plans & pricing*. Token accounting happens only on the server
(`api/generate.js` → `ai_budget_check` / `ai_record_usage`, executable only with the service key).

## Tests

`tests/e2e-mock.cjs`, `tests/e2e-qa-fixes.cjs`, `tests/e2e-hierarchy.cjs` and `tests/e2e-billing.cjs` run the app in a headless browser
against a simulated Supabase (`NODE_PATH=/opt/npm-tools/node_modules node tests/<file>`).

`tests/sql/run.sh` runs the database security suites (base guarantees, hierarchy permissions, plan & usage) on a local
Postgres 16: `PGHOST=… PGPORT=… PGUSER=postgres tests/sql/run.sh`.
API: `node --no-warnings --test tests/api-billing.test.mjs tests/api-live.test.mjs`.

## Live class (Aula en vivo)

In-app video classroom, currently in **Demo mode** (simulated participants, sample insights, no cost).
To connect real video set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in Vercel.
See `docs/live-class.md` (activation, costs, privacy checklist). Tests: `tests/e2e-live.cjs`,
`tests/api-live.test.mjs`, `tests/sql/002_live_class_rls.sql`.
