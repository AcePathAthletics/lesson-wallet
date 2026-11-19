# Credits move only through database functions, enforced by grants

Status: accepted (2026-11-19)

## Context

`fn_complete_attendance` was meant to be the single path that spends a
credit, but Supabase grants `authenticated` full table privileges and the
teacher RLS policies are `FOR ALL`. Any signed-in teacher could update
`enrollment.used_lessons`, mark attendance `completed` without a deduction,
or delete a completed lesson, all straight through PostgREST. The tests did
not notice because the pglite harness granted privileges after the
migrations ran, so it could not model a revoke at all.

## Decision

Migration `0005_lock_ledger_writes.sql` revokes client INSERT/UPDATE/DELETE on
`enrollment` and `attendance` and grants back only these columns:

- enrollment: insert `student_id, course_id, purchased_lessons`; update `purchased_lessons`
- attendance: insert of scheduled/imported rows only (restrictive RLS policy),
  which is what `calendar-import-confirm` needs

The SECURITY DEFINER functions are unaffected. The harness now sets up roles
and default privileges before the migrations, as Supabase does.

## Consequences

- Ledger invariant `used_lessons = count(completed attendance)` holds for
  every client-created enrollment, and `tests/db/ledger.db.test.js` reconciles it.
- Any future client feature that edits attendance (rescheduling, notes) needs
  either a column grant in a new migration or a SECURITY DEFINER function.
- Must be applied to the hosted project with `supabase db push` (needs sign-off).
