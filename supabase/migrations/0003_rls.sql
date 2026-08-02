-- Lesson Wallet — Row Level Security (spec §6.4)
--
-- Rule: a teacher sees only their own roster; a student sees only their own
-- rows and never another student's balance. Enforced in the database, not the
-- client, so a compromised app build still cannot read someone else's data.

alter table app_user            enable row level security;
alter table teacher             enable row level security;
alter table student             enable row level security;
alter table course              enable row level security;
alter table enrollment          enable row level security;
alter table attendance          enable row level security;
alter table package             enable row level security;
alter table payment             enable row level security;
alter table calendar_connection enable row level security;
alter table calendar_sync_log   enable row level security;

-- "course" and "enrollment" each need to check a fact that lives in the
-- other table (is this course mine?, is this student enrolled?). Written as
-- plain EXISTS subqueries inside the policies, that's circular: evaluating
-- course's policy triggers enrollment's RLS, which triggers course's policy
-- again, forever ("infinite recursion detected in policy for relation").
-- SECURITY DEFINER functions run with the privileges of their owner, and an
-- owner that hasn't been forced (no FORCE ROW LEVEL SECURITY) bypasses RLS
-- on that table -- exactly like the trigger functions in 0001 and 0002
-- already do. Routing the cross-table lookup through one breaks the cycle:
-- the lookup itself no longer re-enters the caller's RLS.
create or replace function fn_is_own_course(p_course_id uuid, p_teacher_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $fn$
  select exists (
    select 1 from course c where c.id = p_course_id and c.teacher_id = p_teacher_id
  )
$fn$;

create or replace function fn_is_enrolled(p_course_id uuid, p_student_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $fn$
  select exists (
    select 1 from enrollment e where e.course_id = p_course_id and e.student_id = p_student_id
  )
$fn$;

-- ---------- app_user ----------
create policy user_reads_self on app_user
  for select using (id = auth.uid());
create policy user_updates_self on app_user
  for update using (id = auth.uid());

-- A teacher may read the profile rows of their own students.
create policy teacher_reads_own_students on app_user
  for select using (
    exists (select 1 from student s where s.user_id = app_user.id and s.teacher_id = auth.uid())
  );

-- ---------- teacher / student ----------
create policy teacher_rw_self on teacher
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy student_reads_self on student
  for select using (user_id = auth.uid());
create policy teacher_rw_own_students on student
  for all using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

-- ---------- course ----------
create policy teacher_rw_own_courses on course
  for all using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

create policy student_reads_enrolled_courses on course
  for select using (fn_is_enrolled(course.id, auth.uid()));

-- ---------- enrollment ----------
create policy student_reads_own_enrollment on enrollment
  for select using (student_id = auth.uid());

create policy teacher_rw_roster_enrollment on enrollment
  for all using (
    fn_is_own_course(enrollment.course_id, auth.uid())
  ) with check (
    fn_is_own_course(enrollment.course_id, auth.uid())
  );

-- ---------- attendance ----------
create policy student_reads_own_attendance on attendance
  for select using (student_id = auth.uid());

create policy teacher_rw_own_attendance on attendance
  for all using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

-- ---------- package / payment ----------
create policy teacher_rw_own_packages on package
  for all using (
    exists (select 1 from course c where c.id = package.course_id and c.teacher_id = auth.uid())
  ) with check (
    exists (select 1 from course c where c.id = package.course_id and c.teacher_id = auth.uid())
  );

create policy student_reads_own_payments on payment
  for select using (student_id = auth.uid());

create policy teacher_reads_roster_payments on payment
  for select using (
    exists (select 1 from student s where s.user_id = payment.student_id and s.teacher_id = auth.uid())
  );

-- ---------- calendar ----------
-- Tokens are never readable by anyone but their owner.
create policy calendar_rw_self on calendar_connection
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy sync_log_reads_own on calendar_sync_log
  for select using (
    exists (
      select 1 from calendar_connection cc
      where cc.id = calendar_sync_log.connection_id and cc.user_id = auth.uid()
    )
  );
