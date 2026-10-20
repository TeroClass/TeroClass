#!/bin/bash
# SQL security suites against a local Postgres 16 (no Supabase needed).
# Usage: PGHOST=/var/tmp/hierpg PGPORT=5441 PGUSER=postgres tests/sql/run.sh
# Creates a throwaway database, loads a Supabase stub (auth/storage/roles) and
# supabase/migrations/001_base.sql twice (must be idempotent), then runs
# security.sql (base guarantees), hierarchy.sql (3-level permissions) and billing.sql
# (plan & usage: seats, monthly AI tokens, token packs), insights.sql (AI request metadata + super admin
# platform insights) and students.sql (groups, students, calendar: privacy rules, claim by verified email,
# calendar feed, CSV import) and csv_schedule.sql (CSV with schedules, pending teachers, auto-assign, privacy);
# finally re-runs 001_base.sql on the populated database (superadmins must be kept, owner references hidden) and
# checks two upgrade paths: 001_base.sql from git da29348 (before groups/students) + data, then the current one
# twice, then students.sql; and 001_base.sql from git fabb1c7 (groups/students, before CSV schedules) + students.sql
# data, then the current one twice (the data must survive), then csv_schedule.sql.
# Class insights (class_insights.sql: privacy rules + idempotent demo generation) run with the other suites and
# again after an upgrade from git c198c60 (before class insights) with data. 002_live_class.sql must still apply
# (twice) after the current 001 and pass its RLS suite; 001 must re-run after 002; and a database where the OLD
# 002 (insights tied to live_sessions) had been run with data upgrades cleanly (old tables kept as *_live_legacy).
# Class document + attendance (classdoc_attendance.sql: access matrix, lock, versions/restore, Realtime policies, attendance
# privacy, late rule, overrides, report) run with the other suites, after the c198c60 upgrade, and after an upgrade from git
# d063eb0 (class insights, before the class document) with data (+ the current 001 twice; the data must survive).
set -e
cd "$(dirname "$0")/../.."
DB=tc_sqltest_$$
PSQL="psql -X -q -v ON_ERROR_STOP=1"
$PSQL -d postgres -c "create database $DB" >/dev/null
trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$PSQL -d $DB -f tests/sql/supabase-stub.sql >/dev/null 2>&1
for i in 1 2; do $PSQL -d $DB -f supabase/migrations/001_base.sql >/dev/null 2>&1; done
fail=0
for t in security hierarchy billing insights students csv_schedule class_insights classdoc_attendance; do
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
# Upgrade path from the version before CSV schedules (fabb1c7) with groups, students and classes in it
if git cat-file -e fabb1c7:supabase/migrations/001_base.sql 2>/dev/null; then
  UP2=${DB}_up2
  $PSQL -d postgres -c "create database $UP2" >/dev/null
  trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up" >/dev/null; $PSQL -d postgres -c "drop database if exists $UP2" >/dev/null' EXIT
  $PSQL -d $UP2 -f tests/sql/supabase-stub.sql >/dev/null 2>&1
  DATA="select (select count(*) from public.class_groups)||'/'||(select count(*) from public.student_enrollments)||'/'||(select count(*) from public.group_members)||'/'||(select count(*) from public.class_sessions)||'/'||(select count(*) from public.session_series)||'/'||(select count(*) from public.profiles)"
  if git show fabb1c7:supabase/migrations/001_base.sql | $PSQL -d $UP2 >/dev/null 2>&1 \
     && $PSQL -d $UP2 -f tests/sql/students.sql >/dev/null 2>&1; then
    before=$($PSQL -At -d $UP2 -c "$DATA")
    if $PSQL -d $UP2 -f supabase/migrations/001_base.sql >/dev/null 2>&1 && $PSQL -d $UP2 -f supabase/migrations/001_base.sql >/dev/null 2>&1; then
      after=$($PSQL -At -d $UP2 -c "$DATA")
      origin=$($PSQL -At -d $UP2 -c "select count(*) from public.session_series where origin <> 'manual'")
      if [[ "$before" == "$after" && "$origin" == "0" && "$before" != "0/0/0/0/0/0" ]]; then echo "upgrade (fabb1c7 + data → current ×2): data kept ($after), old series = manual"; else echo "upgrade: **FAIL** fabb1c7 data before=$before after=$after csv-series=$origin"; fail=1; fi
      out=$($PSQL -d $UP2 -f tests/sql/csv_schedule.sql 2>&1)
      echo "$out" | grep -E '\*\*FAIL\*\*' || true
      sum=$(echo "$out" | grep -E '^ +[0-9]+ \| +[0-9]+$' | tail -1)
      echo "upgrade (fabb1c7 → current ×2) + csv_schedule: passed | failed = $sum"
      [[ "$sum" =~ \|\ +0$ ]] || fail=1
    else echo "upgrade: **FAIL** could not upgrade from fabb1c7"; fail=1; fi
  else echo "upgrade: **FAIL** could not load fabb1c7 + data"; fail=1; fi
fi
# 002_live_class.sql after the current 001 (twice), its RLS suite, then 001 and 002 again
LV=${DB}_live
$PSQL -d postgres -c "create database $LV" >/dev/null
trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up2" >/dev/null; $PSQL -d postgres -c "drop database if exists $LV" >/dev/null' EXIT
$PSQL -d $LV -f tests/sql/supabase-stub.sql >/dev/null 2>&1
if $PSQL -d $LV -f supabase/migrations/001_base.sql >/dev/null 2>&1 \
   && $PSQL -d $LV -f supabase/migrations/002_live_class.sql >/dev/null 2>&1 \
   && $PSQL -d $LV -f supabase/migrations/002_live_class.sql >/dev/null 2>&1; then
  out=$($PSQL -d $LV -f tests/sql/002_live_class_rls.sql 2>&1 || true)
  if echo "$out" | grep -q 'ALL LIVE-CLASS RLS TESTS PASSED' \
     && $PSQL -d $LV -f supabase/migrations/001_base.sql >/dev/null 2>&1 && $PSQL -d $LV -f supabase/migrations/002_live_class.sql >/dev/null 2>&1; then
    echo "002 after current 001 (×2) + 002 RLS suite + 001/002 re-run: ok"
  else echo "002: **FAIL** $(echo "$out" | grep -E 'FAIL|ERROR' | head -3)"; fail=1; fi
else echo "002: **FAIL** 002_live_class.sql does not apply after the current 001"; fail=1; fi
# Upgrade from c198c60 (before class insights) with data, and with the OLD 002 (insights tied to live_sessions) run
if git cat-file -e c198c60:supabase/migrations/001_base.sql 2>/dev/null; then
  UP3=${DB}_up3
  $PSQL -d postgres -c "create database $UP3" >/dev/null
  trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up2" >/dev/null; $PSQL -d postgres -c "drop database if exists $LV" >/dev/null; $PSQL -d postgres -c "drop database if exists $UP3" >/dev/null' EXIT
  $PSQL -d $UP3 -f tests/sql/supabase-stub.sql >/dev/null 2>&1
  DATA="select (select count(*) from public.class_groups)||'/'||(select count(*) from public.student_enrollments)||'/'||(select count(*) from public.group_members)||'/'||(select count(*) from public.class_sessions)||'/'||(select count(*) from public.session_series)||'/'||(select count(*) from public.profiles)||'/'||(select count(*) from public.live_sessions)"
  if git show c198c60:supabase/migrations/001_base.sql | $PSQL -d $UP3 >/dev/null 2>&1 \
     && $PSQL -d $UP3 -f tests/sql/students.sql >/dev/null 2>&1 && $PSQL -d $UP3 -f tests/sql/csv_schedule.sql >/dev/null 2>&1 \
     && git show c198c60:supabase/migrations/002_live_class.sql | $PSQL -d $UP3 >/dev/null 2>&1 \
     && git show c198c60:tests/sql/002_live_class_rls.sql | $PSQL -d $UP3 >/dev/null 2>&1; then
    before=$($PSQL -At -d $UP3 -c "$DATA")
    if $PSQL -d $UP3 -f supabase/migrations/001_base.sql >/dev/null 2>&1 && $PSQL -d $UP3 -f supabase/migrations/001_base.sql >/dev/null 2>&1 \
       && $PSQL -d $UP3 -f supabase/migrations/002_live_class.sql >/dev/null 2>&1; then
      after=$($PSQL -At -d $UP3 -c "$DATA")
      legacy=$($PSQL -At -d $UP3 -c "select (select count(*) from public.student_insights_live_legacy)||'/'||(select count(*) from public.teacher_insights_live_legacy)||'/'||(select count(*) from public.student_insights)")
      if [[ "$before" == "$after" && "$legacy" == "2/1/0" ]]; then echo "upgrade (c198c60 + data + old 002 → current 001 ×2 → 002): data kept ($after), old insights kept as *_live_legacy ($legacy)"; else echo "upgrade: **FAIL** c198c60 before=$before after=$after legacy=$legacy"; fail=1; fi
      out=$($PSQL -d $UP3 -f tests/sql/class_insights.sql 2>&1)
      echo "$out" | grep -E '\*\*FAIL\*\*' || true
      sum=$(echo "$out" | grep -E '^ +[0-9]+ \| +[0-9]+$' | tail -1)
      echo "upgrade (c198c60 → current ×2) + class_insights: passed | failed = $sum"
      [[ "$sum" =~ \|\ +0$ ]] || fail=1
      out=$($PSQL -d $UP3 -f tests/sql/classdoc_attendance.sql 2>&1)
      echo "$out" | grep -E '\*\*FAIL\*\*' || true
      sum=$(echo "$out" | grep -E '^ +[0-9]+ \| +[0-9]+$' | tail -1)
      echo "upgrade (c198c60 → current ×2) + classdoc_attendance: passed | failed = $sum"
      [[ "$sum" =~ \|\ +0$ ]] || fail=1
    else echo "upgrade: **FAIL** could not upgrade from c198c60"; fail=1; fi
  else echo "upgrade: **FAIL** could not load c198c60 + data"; fail=1; fi
fi
# Upgrade from d063eb0 (class insights, before the class document + attendance) with data, then the current 001 twice
if git cat-file -e d063eb0:supabase/migrations/001_base.sql 2>/dev/null; then
  UP4=${DB}_up4
  $PSQL -d postgres -c "create database $UP4" >/dev/null
  trap '$PSQL -d postgres -c "drop database if exists $DB" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up2" >/dev/null; $PSQL -d postgres -c "drop database if exists $LV" >/dev/null; $PSQL -d postgres -c "drop database if exists ${DB}_up3" >/dev/null; $PSQL -d postgres -c "drop database if exists $UP4" >/dev/null' EXIT
  $PSQL -d $UP4 -f tests/sql/supabase-stub.sql >/dev/null 2>&1
  DATA="select (select count(*) from public.class_groups)||'/'||(select count(*) from public.student_enrollments)||'/'||(select count(*) from public.group_members)||'/'||(select count(*) from public.class_sessions)||'/'||(select count(*) from public.session_series)||'/'||(select count(*) from public.profiles)||'/'||(select count(*) from public.teacher_insights)||'/'||(select count(*) from public.student_insights)"
  if git show d063eb0:supabase/migrations/001_base.sql | $PSQL -d $UP4 >/dev/null 2>&1 \
     && $PSQL -d $UP4 -f tests/sql/students.sql >/dev/null 2>&1 && $PSQL -d $UP4 -f tests/sql/csv_schedule.sql >/dev/null 2>&1 \
     && git show d063eb0:tests/sql/class_insights.sql | $PSQL -d $UP4 >/dev/null 2>&1; then
    before=$($PSQL -At -d $UP4 -c "$DATA")
    if $PSQL -d $UP4 -f supabase/migrations/001_base.sql >/dev/null 2>&1 && $PSQL -d $UP4 -f supabase/migrations/001_base.sql >/dev/null 2>&1 \
       && $PSQL -d $UP4 -f supabase/migrations/002_live_class.sql >/dev/null 2>&1; then
      after=$($PSQL -At -d $UP4 -c "$DATA")
      if [[ "$before" == "$after" && "$before" != *"/0/0" ]]; then echo "upgrade (d063eb0 + data → current 001 ×2 → 002): data kept ($after)"; else echo "upgrade: **FAIL** d063eb0 before=$before after=$after"; fail=1; fi
      out=$($PSQL -d $UP4 -f tests/sql/classdoc_attendance.sql 2>&1)
      echo "$out" | grep -E '\*\*FAIL\*\*' || true
      sum=$(echo "$out" | grep -E '^ +[0-9]+ \| +[0-9]+$' | tail -1)
      echo "upgrade (d063eb0 → current ×2) + classdoc_attendance: passed | failed = $sum"
      [[ "$sum" =~ \|\ +0$ ]] || fail=1
    else echo "upgrade: **FAIL** could not upgrade from d063eb0"; fail=1; fi
  else echo "upgrade: **FAIL** could not load d063eb0 + data"; fail=1; fi
fi
exit $fail
