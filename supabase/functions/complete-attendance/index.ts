// POST /functions/v1/complete-attendance   (spec §9)
//
// Accepts EITHER { attendanceId }            → complete a pre-scheduled ticket
//         OR     { studentId, courseId }     → ad-hoc "log as you go" (§3.3)
//
// Both delegate to fn_complete_attendance so the credit deduction is atomic
// and identical regardless of entry point.

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  let body: Record<string, string | undefined>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { attendanceId, studentId, courseId } = body;
  if (!attendanceId && !(studentId && courseId)) {
    return json(
      { error: 'Provide attendanceId, or both studentId and courseId' },
      400
    );
  }

  const { data, error } = await supabase.rpc('fn_complete_attendance', {
    p_attendance_id: attendanceId ?? null,
    p_student_id: studentId ?? null,
    p_course_id: courseId ?? null,
  });

  if (error) {
    // P0001 = business rule (already completed / no credits) → 409, not 500.
    const status = error.code === 'P0001' ? 409 : error.code === 'P0002' ? 404 : 400;
    return json({ error: error.message, code: error.code }, status);
  }

  return json({ attendance: data }, 200);
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
