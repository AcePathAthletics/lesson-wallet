-- Lesson Wallet — one deduction path, enforced by privileges (not convention).
--
-- 0002 made fn_complete_attendance the single place a credit is spent, but
-- Supabase grants `authenticated` full INSERT/UPDATE/DELETE on every public
-- table, and the teacher RLS policies are FOR ALL. So any signed-in teacher
-- could, straight through PostgREST:
--   * update enrollment.used_lessons (move credits with no lesson), or
--   * set attendance.status = 'completed' (a lesson with no deduction), or
--   * delete a completed attendance row (a deduction with no lesson).
-- Each breaks the ledger: used_lessons = count(completed attendance).
--
-- The SECURITY DEFINER functions (fn_complete_attendance,
-- fn_cancel_attendance) run as their owner and are unaffected.
-- tests/db/ledger.db.test.js proves both sides.

-- ---------- enrollment ----------
-- Teachers create enrollments and top up purchased_lessons; nothing else.
revoke insert, update on enrollment from anon, authenticated;
grant insert (student_id, course_id, purchased_lessons) on enrollment to authenticated;
grant update (purchased_lessons) on enrollment to authenticated;

-- ---------- attendance ----------
-- Clients may create scheduled/imported lessons (calendar-import-confirm runs
-- with the teacher's JWT), but never complete, edit or delete one.
revoke insert, update, delete on attendance from anon, authenticated;
grant insert (student_id, course_id, teacher_id, scheduled_at, status, source, external_event_id)
  on attendance to authenticated;

create policy attendance_insert_never_completed on attendance
  as restrictive
  for insert to authenticated
  with check (status in ('scheduled', 'imported'));
