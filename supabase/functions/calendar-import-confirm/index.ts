// POST /functions/v1/calendar-import-confirm   (spec §7.4 step 5)
//
// Writes the teacher's confirmed selections as attendance rows.
// Import creates SCHEDULED lessons — it does not deduct credits; the credit
// is spent later when the lesson is actually completed.

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData } = await supabase.auth.getUser();
  const teacherId = userData?.user?.id;
  if (!teacherId) return json({ error: 'Not authenticated' }, 401);

  const { selections } = await req.json();
  if (!Array.isArray(selections) || selections.length === 0) {
    return json({ error: 'selections must be a non-empty array' }, 400);
  }

  const rows = selections
    .filter((s) => s.studentId && s.courseId && s.externalEventId)
    .map((s) => ({
      student_id: s.studentId,
      course_id: s.courseId,
      teacher_id: teacherId,
      scheduled_at: s.startsAt,
      status: 'imported',
      source: 'calendar_import',
      external_event_id: s.externalEventId,
    }));

  if (rows.length === 0) return json({ error: 'No valid selections' }, 400);

  // upsert on (teacher_id, external_event_id) makes re-import a no-op.
  const { data, error } = await supabase
    .from('attendance')
    .upsert(rows, { onConflict: 'teacher_id,external_event_id', ignoreDuplicates: true })
    .select();

  if (error) return json({ error: error.message }, 400);

  return json({ imported: data?.length ?? 0, attendance: data }, 200);
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
