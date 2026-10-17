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

## Tests

`tests/e2e-mock.cjs` runs the full flow in a headless browser against a simulated Supabase.

## Live class (Aula en vivo)

In-app video classroom, currently in **Demo mode** (simulated participants, sample insights, no cost).
To connect real video set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in Vercel.
See `docs/live-class.md` (activation, costs, privacy checklist). Tests: `tests/e2e-live.cjs`,
`tests/api-live.test.mjs`, `tests/sql/002_live_class_rls.sql`.
