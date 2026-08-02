-- Lesson Wallet — the single credit-deduction write path (spec §5, §3.3).
--
-- Every way a lesson gets completed (tapping a scheduled ticket, the ad-hoc
-- "+" button, or completing an imported lesson) funnels through this one
-- function, inside one transaction. That is what makes it impossible for the
-- balance to drift depending on which screen the teacher used.

create or replace function fn_complete_attendance(
  p_attendance_id uuid default null,
  p_student_id    uuid default null,
  p_course_id     uuid default null
)
returns attendance
language plpgsql
security definer set search_path = public
as $$
declare
  v_teacher_id uuid;
  v_att        attendance;
  v_enr        enrollment;
  v_now        timestamptz := now();
begin
  -- Caller must be the teacher who owns the lesson.
  select user_id into v_teacher_id from teacher where user_id = auth.uid();
  if v_teacher_id is null then
    raise exception 'Only a teacher may complete a lesson'
      using errcode = '42501';
  end if;

  if p_attendance_id is not null then
    -- Path A: completing a pre-scheduled / imported ticket.
    select * into v_att from attendance
      where id = p_attendance_id and teacher_id = v_teacher_id
      for update;

    if not found then
      raise exception 'Attendance % not found for this teacher', p_attendance_id
        using errcode = 'P0002';
    end if;
    if v_att.status = 'completed' then
      raise exception 'Attendance % already completed', p_attendance_id
        using errcode = 'P0001';
    end if;
    if v_att.status = 'cancelled' then
      raise exception 'Attendance % is cancelled', p_attendance_id
        using errcode = 'P0001';
    end if;
  else
    -- Path B: ad-hoc "log as you go" — no prior row exists (spec §3.3).
    if p_student_id is null or p_course_id is null then
      raise exception 'Provide either p_attendance_id, or both p_student_id and p_course_id'
        using errcode = '22023';
    end if;

    insert into attendance (
      student_id, course_id, teacher_id, scheduled_at, status, source
    )
    values (
      p_student_id, p_course_id, v_teacher_id, v_now, 'scheduled', 'manual'
    )
    returning * into v_att;
    -- scheduled_at = completed_at below marks this as logged-in-the-moment.
  end if;

  -- Lock the enrollment row so concurrent taps can't double-spend a credit.
  select * into v_enr from enrollment
    where student_id = v_att.student_id and course_id = v_att.course_id
    for update;

  if not found then
    raise exception 'No enrollment for student % on course %', v_att.student_id, v_att.course_id
      using errcode = 'P0002';
  end if;
  if v_enr.remaining_lessons <= 0 then
    raise exception 'No remaining credits for this course'
      using errcode = 'P0001';
  end if;

  update enrollment
     set used_lessons = used_lessons + 1
   where id = v_enr.id;

  update attendance
     set status = 'completed',
         completed_at = v_now
   where id = v_att.id
  returning * into v_att;

  return v_att;
end;
$$;

-- Undo: restore a credit and mark the lesson cancelled.
create or replace function fn_cancel_attendance(p_attendance_id uuid)
returns attendance
language plpgsql
security definer set search_path = public
as $$
declare
  v_att attendance;
begin
  select * into v_att from attendance
    where id = p_attendance_id and teacher_id = auth.uid()
    for update;

  if not found then
    raise exception 'Attendance % not found for this teacher', p_attendance_id
      using errcode = 'P0002';
  end if;

  if v_att.status = 'completed' then
    update enrollment
       set used_lessons = greatest(0, used_lessons - 1)
     where student_id = v_att.student_id and course_id = v_att.course_id;
  end if;

  update attendance set status = 'cancelled' where id = v_att.id
  returning * into v_att;

  return v_att;
end;
$$;
