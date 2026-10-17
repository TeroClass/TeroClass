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

## Database

Run `supabase/migrations/001_base.sql` in Supabase → SQL Editor (safe to re-run).

Institutions form a hierarchy of up to 3 levels: main institution › campus/faculty › department/area
(`institutions.parent_id`). Admins of a unit manage everything below it; sub-units inherit branding,
master prompt, playbooks and learning-approach bars (`get_effective_config`).

## Tests

`tests/e2e-mock.cjs`, `tests/e2e-qa-fixes.cjs` and `tests/e2e-hierarchy.cjs` run the app in a headless browser
against a simulated Supabase (`NODE_PATH=/opt/npm-tools/node_modules node tests/<file>`).

`tests/sql/run.sh` runs the database security suites (base guarantees + hierarchy permissions) on a local
Postgres 16: `PGHOST=… PGPORT=… PGUSER=postgres tests/sql/run.sh`.
