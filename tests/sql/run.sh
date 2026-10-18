#!/bin/bash
# SQL security suites against a local Postgres 16 (no Supabase needed).
# Usage: PGHOST=/var/tmp/hierpg PGPORT=5441 PGUSER=postgres tests/sql/run.sh
# Creates a throwaway database, loads a Supabase stub (auth/storage/roles) and
# supabase/migrations/001_base.sql twice (must be idempotent), then runs
# security.sql (base guarantees), hierarchy.sql (3-level permissions) and billing.sql
# (plan & usage: seats, monthly AI tokens, token packs), insights.sql (AI request metadata + super admin
# platform insights) and students.sql (groups, students, calendar: privacy rules, claim by verified email,
# calendar feed, CSV import); finally re-runs 001_base.sql on the populated
# database (superadmins must be kept, owner references hidden) and checks the upgrade path:
# 001_base.sql from git da29348 (before groups/students) + data, then the current one twice, then students.sql.
set -e
cd "$(dirname "$0")/../.."
DB=tc_sqltest_$$
PSQL="psql -X -q -v ON_ERROR_STOP=1"
$PSQL -d postgres -c "create database $DB" >/dev/null
trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -d $DB -f tests/sql/supabase-stub.sql >/dev/null 2>&1
for i in 1 2; do $PSQL -d $DB -f supabase/migrations/001_base.sql >/dev/null 2>&1; done
fail=0
for t in security hierarchy billing insights students; do
  out=$($PSQL -d $DB -f tests/sql/$t.sql 2>&1)
  echo "$out" | grep -E '\*\*FAIL\*\*' || true
  sum=$(echo "$out" | grep -E '^ +[0-9]+ \| +[0-9]+$' | tail -1)
  echo "$t: passed | failed = $sum"
  [[ "$sum" =~ \|\ +0$ ]] || fail=1
done
# Re-run on the populated database: must apply cleanly and keep every superadmin (never demote,
# never promote anyone else, owner references stay hidden).
before=$($PSQL -At -d $DB -c "select string_agg(id::text, ',' order by id) from public.profiles where role='superadmin'")
if $PSQL -d $DB -f supabase/migrations/001_base.sql >/dev/null 2>&1; then
  after=$($PSQL -At -d $DB -c "select string_agg(id::text, ',' order by id) from public.profiles where role='superadmin'")
  refs=$($PSQL -At -d $DB -c "select (select count(*) from public.institutions where public.is_superadmin_id(created_by)) + (select count(*) from public.invitations where public.is_superadmin_id(invited_by)) + (select count(*) from public.institution_documents where public.is_superadmin_id(uploaded_by))")
  if [[ -n "$before" && "$before" == "$after" && "$refs" == "0" ]]; then echo "rerun: superadmins kept ($after), owner refs hidden"; else echo "rerun: **FAIL** before=$before after=$after refs=$refs"; fail=1; fi
else echo "rerun: **FAIL** 001_base.sql failed on the populated database"; fail=1; fi
# Upgrade path from the version before groups/students (skipped outside a git checkout)
if git cat-file -e da29348:supabase/migrations/001_base.sql 2>/dev/null; then
  UP=${DB}_up
  $PSQL -d postgres -c "create database $UP" >/dev/null
  trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null; $PSQL -d postgres -c "drop database if exists $UP" >/dev/null' EXIT
  $PSQL -d $UP -f tests/sql/supabase-stub.sql >/dev/null 2>&1
  if git show da29348:supabase/migrations/001_base.sql | $PSQL -d $UP >/dev/null 2>&1 \
     && $PSQL -d $UP -f tests/sql/hierarchy.sql >/dev/null 2>&1 \
     && $PSQL -d $UP -f supabase/migrations/001_base.sql >/dev/null 2>&1 \
     && $PSQL -d $UP -f supabase/migrations/001_base.sql >/dev/null 2>&1; then
    out=$($PSQL -d $UP -f tests/sql/students.sql 2>&1)
    echo "$out" | grep -E '\*\*FAIL\*\*' || true
    sum=$(echo "$out" | grep -E '^ +[0-9]+ \| +[0-9]+$' | tail -1)
    echo "upgrade (da29348 → current ×2) + students: passed | failed = $sum"
    [[ "$sum" =~ \|\ +0$ ]] || fail=1
  else echo "upgrade: **FAIL** could not upgrade from da29348"; fail=1; fi
fi
exit $fail
