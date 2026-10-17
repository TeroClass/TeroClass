#!/bin/bash
# SQL security suites against a local Postgres 16 (no Supabase needed).
# Usage: PGHOST=/var/tmp/hierpg PGPORT=5441 PGUSER=postgres tests/sql/run.sh
# Creates a throwaway database, loads a Supabase stub (auth/storage/roles) and
# supabase/migrations/001_base.sql twice (must be idempotent), then runs
# security.sql (base guarantees), hierarchy.sql (3-level permissions) and billing.sql
# (plan & usage: seats, monthly AI tokens, token packs).
set -e
cd "$(dirname "$0")/../.."
DB=tc_sqltest_$$
PSQL="psql -X -q -v ON_ERROR_STOP=1"
$PSQL -d postgres -c "create database $DB" >/dev/null
trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -d $DB -f tests/sql/supabase-stub.sql >/dev/null 2>&1
for i in 1 2; do $PSQL -d $DB -f supabase/migrations/001_base.sql >/dev/null 2>&1; done
fail=0
for t in security hierarchy billing; do
  out=$($PSQL -d $DB -f tests/sql/$t.sql 2>&1)
  echo "$out" | grep -E '\*\*FAIL\*\*' || true
  sum=$(echo "$out" | grep -E '^ +[0-9]+ \| +[0-9]+$' | tail -1)
  echo "$t: passed | failed = $sum"
  [[ "$sum" =~ \|\ +0$ ]] || fail=1
done
exit $fail
